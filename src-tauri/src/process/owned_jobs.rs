//! Linux 下 shell 退出后，后台作业可能已经换了父进程甚至会话。只在受管的
//! 启动入口传递本实例的标记，退出时据此识别仍在运行的作业。

use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::fs::MetadataExt;
use std::sync::OnceLock;

pub(crate) const KEY: &str = "BEECODE_JOB_OWNER";
static OWNER: OnceLock<String> = OnceLock::new();

pub(crate) fn owner() -> &'static str {
    OWNER.get_or_init(|| uuid::Uuid::new_v4().to_string())
}

pub fn stop_remaining() {
    if let Some(owner) = OWNER.get() {
        sweep(owner);
    }
}

fn sweep(owner: &str) {
    let needle = format!("{KEY}={owner}");
    let uid = unsafe { libc::geteuid() };
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return;
    };
    for entry in entries.flatten() {
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|s| s.parse::<i32>().ok())
        else {
            continue;
        };
        // 先固定进程身份再读标记，避免 PID 在校验和发信号之间被复用。
        let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) };
        if fd < 0 {
            continue;
        }
        let fd = unsafe { OwnedFd::from_raw_fd(fd as i32) };
        if !entry.metadata().is_ok_and(|meta| meta.uid() == uid) {
            continue;
        }
        let Ok(env) = std::fs::read(entry.path().join("environ")) else {
            continue;
        };
        if env
            .split(|&b| b == 0)
            .any(|field| field == needle.as_bytes())
        {
            unsafe {
                libc::syscall(
                    libc::SYS_pidfd_send_signal,
                    fd.as_raw_fd(),
                    libc::SIGKILL,
                    std::ptr::null::<libc::siginfo_t>(),
                    0,
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Read};
    use std::process::{Command, Stdio};

    #[test]
    fn shutdown_tree_finds_a_background_job_after_its_shell_exited() {
        let token = uuid::Uuid::new_v4().to_string();
        let mut shell = Command::new("sh")
            .args(["-c", "sleep 5 & echo ready"])
            .env(KEY, &token)
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut pipe = BufReader::new(shell.stdout.take().unwrap());
        let mut ready = String::new();
        pipe.read_line(&mut ready).unwrap();
        assert_eq!(ready, "ready\n");
        assert!(shell.wait().unwrap().success());
        let mut other = Command::new("sleep")
            .arg("10")
            .env(KEY, uuid::Uuid::new_v4().to_string())
            .spawn()
            .unwrap();
        let start = std::time::Instant::now();
        sweep(&token);
        // sleep 继承了管道，只有它退出后才能读到 EOF。
        pipe.read_to_end(&mut Vec::new()).unwrap();
        let other_alive = other.try_wait().unwrap().is_none();
        let _ = other.kill();
        other.wait().unwrap();
        assert!(start.elapsed() < std::time::Duration::from_secs(3));
        assert!(other_alive);
    }
}
