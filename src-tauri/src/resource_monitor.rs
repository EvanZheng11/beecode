//! 按需资源监控：共享两秒快照；关闭时不采样，也不保留资源历史。
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};

use crate::app_error::AppCommandError;
use crate::db::service::app_metadata_service;

const INTERVAL_MS: u64 = 2_000;
const SETTINGS_KEY: &str = "resource_monitor.enabled";

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Settings {
    pub enabled: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub enabled: bool,
    pub sampled_at: u64,
    pub sample_interval_ms: u64,
    pub collection_duration_ms: u64,
    pub total_cpu_percent: f32,
    pub total_memory_bytes: u64,
    pub active_process_count: usize,
    pub processes: Vec<Process>,
    pub warnings: Vec<String>,
}

impl Snapshot {
    fn empty(enabled: bool) -> Self {
        Self {
            enabled,
            sampled_at: 0,
            sample_interval_ms: INTERVAL_MS,
            collection_duration_ms: 0,
            total_cpu_percent: 0.0,
            total_memory_bytes: 0,
            active_process_count: 0,
            processes: Vec::new(),
            warnings: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Process {
    pid: u32,
    parent_pid: Option<u32>,
    start_time: u64,
    name: String,
    category: String,
    owner_label: Option<String>,
    cpu_percent: f32,
    memory_bytes: u64,
    status: String,
    uptime_seconds: u64,
    can_stop: bool,
    can_kill: bool,
    can_restart: bool,
    action_unavailable_reason: Option<String>,
}

type ActionHandler =
    std::sync::Arc<dyn Fn(u64, Action) -> Result<(), AppCommandError> + Send + Sync>;

#[derive(Clone)]
struct Owner {
    start: u64,
    category: String,
    label: Option<String>,
    controllable: bool,
    handler: Option<ActionHandler>,
    restart: bool,
}

fn registry() -> &'static Mutex<HashMap<u32, Owner>> {
    static REGISTRY: OnceLock<Mutex<HashMap<u32, Owner>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 启动挂点只读取启动标识，不采集 CPU/内存；监控关闭期间也记录归属。
pub fn register_spawn(pid: u32, category: &str, label: Option<String>) {
    if let Some(start) = identity(pid) {
        let mut owners = registry().lock().unwrap_or_else(|e| e.into_inner());
        // 只在启动事件清理失效身份，避免监控长期关闭时积累已结束的启动配置。
        owners.retain(|pid, owner| identity(*pid) == Some(owner.start));
        owners.insert(
            pid,
            Owner {
                start,
                category: category.into(),
                label,
                controllable: matches!(category, "session" | "terminal" | "service"),
                handler: None,
                restart: false,
            },
        );
    }
}

pub fn identity_matches(pid: u32, start: u64) -> bool {
    identity(pid) == Some(start)
}

/// 终端操作通过管理器持有的原始子进程句柄执行，支持各平台生命周期。
pub fn register_terminal(pid: u32, label: String, restart: bool, handler: ActionHandler) {
    register_spawn(pid, "terminal", Some(label));
    if let Some(owner) = registry()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get_mut(&pid)
    {
        owner.handler = Some(handler);
        owner.restart = restart;
    }
}

#[derive(Default)]
struct Collector {
    system: Option<System>,
    cached: Option<(Instant, Snapshot)>,
    samples: usize,
}

impl Collector {
    fn snapshot(&mut self, enabled: bool) -> Snapshot {
        if !enabled {
            self.system = None;
            self.cached = None;
            return Snapshot::empty(false);
        }
        if let Some((at, snapshot)) = &self.cached {
            if at.elapsed() < Duration::from_millis(INTERVAL_MS) {
                return snapshot.clone();
            }
        }
        let started = Instant::now();
        let system = self.system.get_or_insert_with(System::new);
        // 先读取进程树元信息，再仅对已归属进程采集 CPU/内存；不请求或保存参数、环境字段。
        let tree = process_tree(system);
        let mut owners = registry().lock().unwrap_or_else(|e| e.into_inner());
        owners.retain(|pid, owner| identity(*pid) == Some(owner.start));
        let own_pid = std::process::id();
        if let Some(start) = identity(own_pid) {
            owners.insert(
                own_pid,
                Owner {
                    start,
                    category: "backend".into(),
                    label: Some("BeeCode".into()),
                    controllable: false,
                    handler: None,
                    restart: false,
                },
            );
        }
        // 只沿已校验的父子链扩展。已观察到的后代脱离父进程后仍保留归属。
        // ponytail: 首次发现按树深扫描进程表；大规模进程树再改父 PID 索引。
        loop {
            let mut added = Vec::new();
            for (pid, parent_pid, name) in &tree {
                let pid = *pid;
                if owners.contains_key(&pid) {
                    continue;
                }
                let Some(parent_pid) = parent_pid else {
                    continue;
                };
                let Some(parent) = owners.get(parent_pid) else {
                    continue;
                };
                if let Some(start) = verified_child(pid, *parent_pid, parent.start) {
                    let frontend = name.starts_with("WebKit")
                        || name.contains("WebContent")
                        || name.contains("msedgewebview");
                    let category = if frontend {
                        "frontend"
                    } else if name == "codeg-mcp" {
                        "plugin"
                    } else if parent.controllable {
                        "service"
                    } else {
                        "process"
                    };
                    added.push((
                        pid,
                        Owner {
                            start,
                            category: category.into(),
                            label: parent.label.clone(),
                            controllable: parent.controllable && !frontend && category != "plugin",
                            handler: None,
                            restart: false,
                        },
                    ));
                }
            }
            if added.is_empty() {
                break;
            }
            owners.extend(added);
        }
        let pids: Vec<_> = owners.keys().map(|pid| Pid::from_u32(*pid)).collect();
        system.refresh_processes_specifics(
            ProcessesToUpdate::Some(&pids),
            true,
            ProcessRefreshKind::nothing()
                .without_tasks()
                .with_cpu()
                .with_memory(),
        );
        let mut snapshot = Snapshot::empty(true);
        if tree.is_empty() {
            snapshot
                .warnings
                .push("无法枚举进程树，当前仅展示已登记进程。".into());
        }
        snapshot.sampled_at = chrono::Utc::now().timestamp_millis().max(0) as u64;
        snapshot.warnings.push("仅包含本运行实例已登记或已观察到的后代；在首次观察前已脱离父进程的服务可能缺失。未记录可信重启配置的进程不可重启。CPU 百分比按单逻辑核心计，首次采样为零。".into());
        #[cfg(not(target_os = "linux"))]
        snapshot
            .warnings
            .push("当前平台仅支持内置终端原管理器控制；其他归属进程仅展示资源。".into());
        for (pid, owner) in owners.iter() {
            let Some(p) = system.process(Pid::from_u32(*pid)) else {
                continue;
            };
            if identity(*pid) != Some(owner.start) {
                continue;
            }
            let live = !matches!(
                p.status(),
                sysinfo::ProcessStatus::Zombie | sysinfo::ProcessStatus::Dead
            );
            let control = owner.controllable
                && *pid != own_pid
                && live
                && (owner.handler.is_some() || cfg!(target_os = "linux"));
            let cpu = if self.samples == 0 {
                0.0
            } else {
                p.cpu_usage().max(0.0)
            };
            let memory = p.memory();
            if live {
                snapshot.active_process_count += 1;
            }
            snapshot.total_cpu_percent += cpu;
            snapshot.total_memory_bytes = snapshot.total_memory_bytes.saturating_add(memory);
            snapshot.processes.push(Process {
                pid: *pid,
                parent_pid: p.parent().map(|p| p.as_u32()),
                start_time: owner.start,
                name: p.name().to_string_lossy().into_owned(),
                category: owner.category.clone(),
                owner_label: owner.label.clone(),
                cpu_percent: cpu,
                memory_bytes: memory,
                status: p.status().to_string(),
                uptime_seconds: p.run_time(),
                can_stop: control,
                can_kill: control,
                can_restart: control && owner.restart,
                action_unavailable_reason: if control && owner.restart {
                    None
                } else {
                    Some(
                        if control {
                            "未记录可信重启配置，请从原会话或终端重新启动"
                        } else {
                            "核心进程受保护、进程已退出或平台不支持安全控制，请使用原生命周期入口"
                        }
                        .into(),
                    )
                },
            });
        }
        snapshot.processes.sort_by_key(|p| p.pid);
        snapshot.collection_duration_ms = started.elapsed().as_millis() as u64;
        self.samples += 1;
        self.cached = Some((Instant::now(), snapshot.clone()));
        snapshot
    }
}

#[cfg(not(target_os = "macos"))]
fn process_tree(system: &mut System) -> Vec<(u32, Option<u32>, String)> {
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().without_tasks(),
    );
    system
        .processes()
        .iter()
        .map(|(pid, process)| {
            (
                pid.as_u32(),
                process.parent().map(|pid| pid.as_u32()),
                process.name().to_string_lossy().into_owned(),
            )
        })
        .collect()
}

#[cfg(target_os = "macos")]
fn process_tree(_: &mut System) -> Vec<(u32, Option<u32>, String)> {
    // macOS 的 sysinfo 全机刷新会内部读取参数块；仅用 BSD 元信息发现进程树。
    // 资源刷新仍只对已归属 PID 执行，不保留或返回命令行及环境字段。
    // ponytail: 已退出 PID 的库内缓存于关闭时清空；长期高频启停再升级为可裁剪采集器。
    const PROC_ALL_PIDS: u32 = 1;
    let bytes = unsafe { libc::proc_listpids(PROC_ALL_PIDS, 0, std::ptr::null_mut(), 0) };
    if bytes <= 0 || bytes > 16 * 1024 * 1024 {
        return Vec::new();
    }
    let mut pids = vec![0 as libc::pid_t; bytes as usize / std::mem::size_of::<libc::pid_t>() + 64];
    let read = unsafe {
        libc::proc_listpids(
            PROC_ALL_PIDS,
            0,
            pids.as_mut_ptr().cast(),
            std::mem::size_of_val(pids.as_slice()) as i32,
        )
    };
    if read <= 0 {
        return Vec::new();
    }
    pids.truncate(read as usize / std::mem::size_of::<libc::pid_t>());
    pids.into_iter()
        .filter_map(|pid| {
            if pid <= 0 {
                return None;
            }
            let info = mac_process_info(pid as u32)?;
            let name: Vec<u8> = info
                .pbi_name
                .iter()
                .take_while(|&&c| c != 0)
                .map(|&c| c as u8)
                .collect();
            Some((
                pid as u32,
                Some(info.pbi_ppid),
                String::from_utf8_lossy(&name).into_owned(),
            ))
        })
        .collect()
}

#[cfg(target_os = "macos")]
fn mac_process_info(pid: u32) -> Option<libc::proc_bsdinfo> {
    let pid = i32::try_from(pid).ok()?;
    let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of_val(&info) as i32;
    // 缓冲区大小与 BSD 结构一致，只有完整返回后才使用其中的父 PID 与启动时间。
    let read = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTBSDINFO,
            0,
            &mut info as *mut _ as *mut libc::c_void,
            size,
        )
    };
    (read == size).then_some(info)
}

fn collector() -> &'static Mutex<Collector> {
    static COLLECTOR: OnceLock<Mutex<Collector>> = OnceLock::new();
    COLLECTOR.get_or_init(|| {
        // 不为全机进程常驻保留 /proc 文件描述符。
        sysinfo::set_open_files_limit(0);
        Mutex::new(Collector::default())
    })
}

fn settings_lock() -> &'static tokio::sync::Mutex<Option<Settings>> {
    static SETTINGS: OnceLock<tokio::sync::Mutex<Option<Settings>>> = OnceLock::new();
    SETTINGS.get_or_init(|| tokio::sync::Mutex::new(None))
}

async fn loaded_settings(
    conn: &sea_orm::DatabaseConnection,
) -> tokio::sync::MutexGuard<'static, Option<Settings>> {
    let mut settings = settings_lock().lock().await;
    if settings.is_none() {
        let enabled = app_metadata_service::get_value(conn, SETTINGS_KEY)
            .await
            .ok()
            .flatten()
            .and_then(|s| s.parse().ok())
            .unwrap_or(false);
        *settings = Some(Settings { enabled });
    }
    settings
}

pub async fn get_settings(conn: &sea_orm::DatabaseConnection) -> Settings {
    loaded_settings(conn).await.as_ref().unwrap().clone()
}

pub async fn set_enabled(
    conn: &sea_orm::DatabaseConnection,
    enabled: bool,
) -> Result<Settings, AppCommandError> {
    let mut settings = loaded_settings(conn).await;
    app_metadata_service::upsert_value(conn, SETTINGS_KEY, &enabled.to_string()).await?;
    *settings = Some(Settings { enabled });
    if !enabled {
        let mut c = collector().lock().unwrap_or_else(|e| e.into_inner());
        *c = Collector::default();
    }
    Ok(Settings { enabled })
}

pub async fn get_snapshot(conn: &sea_orm::DatabaseConnection) -> Result<Snapshot, AppCommandError> {
    // 与开关写入串行，关闭返回后不会留下仍在进行的资源采样。
    let settings = loaded_settings(conn).await;
    let enabled = settings.as_ref().unwrap().enabled;
    tokio::task::spawn_blocking(move || {
        collector()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .snapshot(enabled)
    })
    .await
    .map_err(|_| AppCommandError::task_execution_failed("资源采集任务失败"))
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Action {
    Stop,
    Kill,
    Restart,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionParams {
    pub pid: u32,
    pub start_time: u64,
    pub action: Action,
}

fn authorize(
    owners: &HashMap<u32, Owner>,
    pid: u32,
    start: u64,
    action: Action,
) -> Result<(), AppCommandError> {
    let owner = owners
        .get(&pid)
        .ok_or_else(|| AppCommandError::permission_denied("进程不属于本运行实例"))?;
    if pid == std::process::id() || !owner.controllable || owner.start != start || start == 0 {
        return Err(AppCommandError::permission_denied(
            "进程受保护或启动标识不匹配",
        ));
    }
    if matches!(action, Action::Restart) && !owner.restart {
        return Err(AppCommandError::permission_denied(
            "未记录可信重启配置，请从原会话或终端重新启动",
        ));
    }
    Ok(())
}

pub fn process_action(params: ActionParams) -> Result<(), AppCommandError> {
    let owners = registry().lock().unwrap_or_else(|e| e.into_inner());
    authorize(&owners, params.pid, params.start_time, params.action)?;
    let owner = owners.get(&params.pid).unwrap().clone();
    drop(owners);
    if let Some(handler) = owner.handler {
        handler(params.start_time, params.action)
    } else {
        signal_checked(params.pid, params.start_time, params.action)
    }
}

#[cfg(target_os = "linux")]
fn signal_checked(pid: u32, start: u64, action: Action) -> Result<(), AppCommandError> {
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    // 先绑定内核进程句柄，再校验启动标识；校验后 PID 被复用也不会误伤新进程。
    let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) };
    if fd < 0 {
        return Err(AppCommandError::io(std::io::Error::last_os_error()));
    }
    let fd = unsafe { OwnedFd::from_raw_fd(fd as i32) };
    let current = linux_stat(pid);
    if !matches!(current, Some((current_start, _, state)) if current_start == start && !matches!(state, 'Z' | 'X' | 'x'))
    {
        return Err(AppCommandError::permission_denied(
            "进程已退出或 PID 已复用",
        ));
    }
    let sig = if matches!(action, Action::Kill) {
        libc::SIGKILL
    } else {
        libc::SIGTERM
    };
    let result = unsafe {
        libc::syscall(
            libc::SYS_pidfd_send_signal,
            fd.as_raw_fd(),
            sig,
            std::ptr::null::<libc::siginfo_t>(),
            0,
        )
    };
    if result < 0 {
        return Err(AppCommandError::io(std::io::Error::last_os_error()));
    }
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn signal_checked(_: u32, _: u64, _: Action) -> Result<(), AppCommandError> {
    Err(AppCommandError::permission_denied(
        "当前平台请通过原生命周期入口控制进程",
    ))
}

#[cfg(target_os = "linux")]
fn linux_stat(pid: u32) -> Option<(u64, u32, char)> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    // comm 中允许空格和括号，最后一个右括号之后才是状态字段。
    let mut fields = stat.rsplit_once(')')?.1.split_whitespace();
    let state = fields.next()?.chars().next()?;
    let parent = fields.next()?.parse().ok()?;
    let start = fields.nth(17)?.parse().ok()?;
    Some((start, parent, state))
}

fn identity(pid: u32) -> Option<u64> {
    let start = crate::computer::procinfo::process_start(pid)?;
    // Windows 的原始 FILETIME 超出 JavaScript 安全整数范围，转换为 Unix 微秒。
    #[cfg(windows)]
    let start = start.saturating_sub(116_444_736_000_000_000) / 10;
    Some(start)
}

#[cfg(target_os = "linux")]
fn verified_child(pid: u32, parent: u32, parent_start: u64) -> Option<u64> {
    let (start, current_parent, _) = linux_stat(pid)?;
    (current_parent == parent && identity(parent) == Some(parent_start)).then_some(start)
}

#[cfg(target_os = "macos")]
fn verified_child(pid: u32, parent: u32, parent_start: u64) -> Option<u64> {
    let info = mac_process_info(pid)?;
    if info.pbi_ppid != parent || identity(parent) != Some(parent_start) {
        return None;
    }
    Some(
        info.pbi_start_tvsec
            .saturating_mul(1_000_000)
            .saturating_add(info.pbi_start_tvusec),
    )
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn verified_child(pid: u32, parent: u32, parent_start: u64) -> Option<u64> {
    // 这些平台的后代仅展示，控制只允许已登记并持有原始句柄的终端。
    if identity(parent) != Some(parent_start) {
        return None;
    }
    identity(pid)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_os = "linux")]
    use std::process::{Child, Command, Stdio};

    fn test_lock() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: Mutex<()> = Mutex::new(());
        LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    #[test]
    fn disabled_does_not_sample_and_enabled_requests_share_cache() {
        let _guard = test_lock();
        let mut collector = Collector::default();
        let disabled_started = Instant::now();
        for _ in 0..1_000 {
            let snapshot = collector.snapshot(false);
            assert!(!snapshot.enabled);
            assert!(snapshot.processes.is_empty());
            assert_eq!(snapshot.sampled_at, 0);
        }
        let disabled_us = disabled_started.elapsed().as_micros();
        assert_eq!(collector.samples, 0);
        let collect_started = Instant::now();
        let first = collector.snapshot(true);
        let collect_us = collect_started.elapsed().as_micros();
        let cached_started = Instant::now();
        for _ in 0..1_000 {
            collector.snapshot(true);
        }
        eprintln!(
            "监控开销：关闭1000次={}µs，首次采样={}µs，缓存1000次={}µs，进程表={}，归属进程={}",
            disabled_us,
            collect_us,
            cached_started.elapsed().as_micros(),
            collector.system.as_ref().unwrap().processes().len(),
            first.processes.len()
        );
        let second = collector.snapshot(true);
        assert_eq!(first.sampled_at, second.sampled_at);
        assert_eq!(collector.samples, 1);
        assert!(first
            .processes
            .iter()
            .any(|p| p.pid == std::process::id() && !p.can_kill));
        assert!(process_action(ActionParams {
            pid: std::process::id(),
            start_time: identity(std::process::id()).unwrap(),
            action: Action::Kill,
        })
        .is_err());
        collector.cached.as_mut().unwrap().0 = Instant::now() - Duration::from_millis(INTERVAL_MS);
        collector.snapshot(true);
        assert_eq!(collector.samples, 2);
        collector.snapshot(false);
        assert!(collector.cached.is_none());
        assert!(collector.system.is_none());
    }

    #[test]
    fn authorization_rejects_external_pid_reuse_core_and_restart() {
        let mut owners = HashMap::new();
        let pid = u32::MAX - 1;
        owners.insert(
            pid,
            Owner {
                start: 123,
                category: "terminal".into(),
                label: None,
                controllable: true,
                handler: None,
                restart: false,
            },
        );
        assert!(authorize(&owners, u32::MAX, 123, Action::Kill).is_err());
        assert!(authorize(&owners, pid, 124, Action::Kill).is_err());
        assert!(authorize(&owners, pid, 123, Action::Restart).is_err());
        assert!(authorize(&owners, pid, 123, Action::Stop).is_ok());
        owners.get_mut(&pid).unwrap().controllable = false;
        assert!(authorize(&owners, pid, 123, Action::Kill).is_err());
    }

    #[cfg(target_os = "linux")]
    struct TestChild(Child);
    #[cfg(target_os = "linux")]
    impl Drop for TestChild {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    #[cfg(target_os = "linux")]
    fn sleeper() -> TestChild {
        TestChild(
            Command::new("/bin/sleep")
                .arg("60")
                .stdin(Stdio::null())
                .spawn()
                .unwrap(),
        )
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn real_child_registered_while_disabled_can_stop_or_kill_but_external_cannot() {
        let _guard = test_lock();
        for action in [Action::Stop, Action::Kill] {
            let mut child = sleeper();
            let pid = child.0.id();
            let start = identity(pid).unwrap();
            let parent = std::process::id();
            let parent_start = identity(parent).unwrap();
            assert_eq!(verified_child(pid, parent, parent_start), Some(start));
            assert!(verified_child(pid, parent, parent_start + 1).is_none());
            assert!(verified_child(pid, parent + 1, parent_start).is_none());
            assert!(process_action(ActionParams {
                pid,
                start_time: start,
                action
            })
            .is_err());
            register_spawn(pid, "terminal", Some("合成测试".into()));
            // 模拟登记旧身份后 PID 已指向另一进程，必须在内核句柄校验处拒绝。
            registry().lock().unwrap().get_mut(&pid).unwrap().start = start + 1;
            assert!(process_action(ActionParams {
                pid,
                start_time: start + 1,
                action: Action::Kill
            })
            .is_err());
            assert!(child.0.try_wait().unwrap().is_none());
            register_spawn(pid, "terminal", Some("合成测试".into()));
            assert!(process_action(ActionParams {
                pid,
                start_time: start + 1,
                action
            })
            .is_err());
            assert!(process_action(ActionParams {
                pid,
                start_time: start,
                action: Action::Restart
            })
            .is_err());
            assert!(child.0.try_wait().unwrap().is_none());
            process_action(ActionParams {
                pid,
                start_time: start,
                action,
            })
            .unwrap();
            let deadline = Instant::now() + Duration::from_secs(2);
            while linux_stat(pid).is_some_and(|(_, _, state)| state != 'Z') {
                assert!(Instant::now() < deadline, "合成进程未按时结束");
                std::thread::sleep(Duration::from_millis(5));
            }
            assert!(process_action(ActionParams {
                pid,
                start_time: start,
                action
            })
            .is_err());
            assert!(!child.0.wait().unwrap().success());
            assert!(process_action(ActionParams {
                pid,
                start_time: start,
                action
            })
            .is_err());
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn observed_service_survives_parent_exit_and_disabled_snapshot() {
        use std::io::{BufRead, BufReader};
        let _guard = test_lock();
        let mut parent = TestChild(
            Command::new("/bin/sh")
                .arg("-c")
                .arg("sleep 60 & echo $!; read hold")
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .spawn()
                .unwrap(),
        );
        let mut line = String::new();
        BufReader::new(parent.0.stdout.take().unwrap())
            .read_line(&mut line)
            .unwrap();
        let pid: u32 = line.trim().parse().unwrap();
        register_spawn(parent.0.id(), "terminal", Some("归属测试".into()));
        let mut collector = Collector::default();
        let before = collector.snapshot(true);
        let child = before.processes.iter().find(|p| p.pid == pid).unwrap();
        assert!(child.can_kill);
        let start = child.start_time;
        parent.0.kill().unwrap();
        parent.0.wait().unwrap();
        collector.snapshot(false);
        let after = collector.snapshot(true);
        assert!(after
            .processes
            .iter()
            .any(|p| p.pid == pid && p.start_time == start));
        process_action(ActionParams {
            pid,
            start_time: start,
            action: Action::Kill,
        })
        .unwrap();
    }

    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn managed_terminal_restart_uses_recorded_launch_and_rejects_old_instance() {
        use crate::terminal::manager::{SpawnOptions, TerminalManager};
        let _guard = test_lock();
        let manager = TerminalManager::new();
        let id = "monitor-restart-test";
        manager
            .spawn_with_id(
                SpawnOptions {
                    terminal_id: id.into(),
                    working_dir: "/tmp".into(),
                    owner_window_label: "test".into(),
                    shell: Some("/bin/sh".into()),
                    initial_command: Some("exec sleep 60".into()),
                    extra_env: None,
                    temp_files: vec![],
                },
                crate::web::event_bridge::EventEmitter::Noop,
            )
            .unwrap();
        let current = || {
            registry()
                .lock()
                .unwrap()
                .iter()
                .find_map(|(pid, owner)| {
                    (owner.label.as_deref() == Some(id) && identity(*pid) == Some(owner.start))
                        .then_some((*pid, owner.start))
                })
                .unwrap()
        };
        let (pid, start) = current();
        let before = Collector::default().snapshot(true);
        assert!(before
            .processes
            .iter()
            .any(|p| p.pid == pid && p.can_restart));
        process_action(ActionParams {
            pid,
            start_time: start,
            action: Action::Restart,
        })
        .unwrap();
        let (new_pid, new_start) = current();
        assert_ne!((pid, start), (new_pid, new_start));
        assert!(process_action(ActionParams {
            pid,
            start_time: start,
            action: Action::Kill
        })
        .is_err());
        assert_eq!(identity(new_pid), Some(new_start));
        process_action(ActionParams {
            pid: new_pid,
            start_time: new_start,
            action: Action::Stop,
        })
        .unwrap();
        assert!(process_action(ActionParams {
            pid: new_pid,
            start_time: new_start,
            action: Action::Restart
        })
        .is_err());
        manager.kill(id).unwrap();
    }

    #[tokio::test]
    async fn settings_default_off_persist_and_disable_clears_sampler() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        *settings_lock().lock().await = None;
        assert!(!get_settings(&db.conn).await.enabled);
        set_enabled(&db.conn, true).await.unwrap();
        assert_eq!(
            app_metadata_service::get_value(&db.conn, SETTINGS_KEY)
                .await
                .unwrap()
                .as_deref(),
            Some("true")
        );
        *settings_lock().lock().await = None;
        assert!(get_settings(&db.conn).await.enabled);
        let (a, b) = tokio::join!(get_snapshot(&db.conn), get_snapshot(&db.conn));
        assert_eq!(a.unwrap().sampled_at, b.unwrap().sampled_at);
        assert_eq!(collector().lock().unwrap().samples, 1);
        set_enabled(&db.conn, false).await.unwrap();
        assert_eq!(collector().lock().unwrap().samples, 0);
        assert!(collector().lock().unwrap().cached.is_none());
        assert!(!get_snapshot(&db.conn).await.unwrap().enabled);
        assert_eq!(collector().lock().unwrap().samples, 0);
        let data = tempfile::tempdir().unwrap();
        let assets = tempfile::tempdir().unwrap();
        let state = std::sync::Arc::new(crate::app_state::AppState::new_for_test(
            db,
            data.path().into(),
        ));
        let router = crate::web::router::build_router(
            state,
            "monitor-test".into(),
            assets.path().into(),
            std::sync::Arc::new(crate::web::shutdown::ShutdownSignal::new()),
        );
        let server = axum_test::TestServer::new(router).unwrap();
        assert_eq!(
            server
                .get("/api/resource-monitor/settings")
                .await
                .status_code(),
            401
        );
        let settings = server
            .get("/api/resource-monitor/settings")
            .add_header("authorization", "Bearer monitor-test")
            .await;
        assert_eq!(settings.json::<serde_json::Value>()["enabled"], false);
        let saved = server
            .put("/api/resource-monitor/settings")
            .add_header("authorization", "Bearer monitor-test")
            .json(&serde_json::json!({"enabled":false}))
            .await;
        assert_eq!(saved.status_code(), 200);
        let snapshot = server
            .get("/api/resource-monitor/snapshot")
            .add_header("authorization", "Bearer monitor-test")
            .await;
        assert_eq!(snapshot.json::<serde_json::Value>()["sampledAt"], 0);
        let denied = server
            .post("/api/resource-monitor/action")
            .add_header("authorization", "Bearer monitor-test")
            .json(&serde_json::json!({"pid":u32::MAX,"startTime":1,"action":"kill"}))
            .await;
        assert_eq!(denied.status_code(), 403);
    }

    #[test]
    fn wire_contract_is_camel_case_and_rejects_unknown_actions() {
        let snapshot = serde_json::to_value(Snapshot::empty(false)).unwrap();
        assert_eq!(snapshot["sampleIntervalMs"], 2000);
        assert!(snapshot.get("sample_interval_ms").is_none());
        assert!(serde_json::from_str::<ActionParams>(
            r#"{"pid":1,"startTime":2,"action":"launch"}"#
        )
        .is_err());
        assert!(
            serde_json::from_str::<ActionParams>(r#"{"pid":1,"startTime":2,"action":"stop"}"#)
                .is_ok()
        );
    }
}

pub mod http {
    use super::*;
    use crate::app_state::AppState;
    use axum::{extract::Extension, Json};
    use std::sync::Arc;
    pub async fn settings(Extension(state): Extension<Arc<AppState>>) -> Json<Settings> {
        Json(get_settings(&state.db.conn).await)
    }
    pub async fn enabled(
        Extension(state): Extension<Arc<AppState>>,
        Json(params): Json<Settings>,
    ) -> Result<Json<Settings>, AppCommandError> {
        set_enabled(&state.db.conn, params.enabled).await.map(Json)
    }
    pub async fn snapshot(
        Extension(state): Extension<Arc<AppState>>,
    ) -> Result<Json<Snapshot>, AppCommandError> {
        get_snapshot(&state.db.conn).await.map(Json)
    }
    pub async fn action(Json(params): Json<ActionParams>) -> Result<(), AppCommandError> {
        tokio::task::spawn_blocking(move || process_action(params))
            .await
            .map_err(|_| AppCommandError::task_execution_failed("进程控制任务失败"))?
    }
}

#[cfg(feature = "tauri-runtime")]
mod desktop {
    use super::*;
    use crate::db::AppDatabase;
    #[tauri::command]
    pub async fn get_resource_monitor_settings(
        db: tauri::State<'_, AppDatabase>,
    ) -> Result<Settings, AppCommandError> {
        Ok(get_settings(&db.conn).await)
    }
    #[tauri::command]
    pub async fn set_resource_monitor_enabled(
        db: tauri::State<'_, AppDatabase>,
        enabled: bool,
    ) -> Result<Settings, AppCommandError> {
        set_enabled(&db.conn, enabled).await
    }
    #[tauri::command]
    pub async fn get_resource_monitor_snapshot(
        db: tauri::State<'_, AppDatabase>,
    ) -> Result<Snapshot, AppCommandError> {
        get_snapshot(&db.conn).await
    }
    #[tauri::command]
    pub async fn resource_monitor_process_action(
        pid: u32,
        start_time: u64,
        action: Action,
    ) -> Result<(), AppCommandError> {
        tokio::task::spawn_blocking(move || {
            process_action(ActionParams {
                pid,
                start_time,
                action,
            })
        })
        .await
        .map_err(|_| AppCommandError::task_execution_failed("进程控制任务失败"))?
    }
}
#[cfg(feature = "tauri-runtime")]
pub use desktop::*;
