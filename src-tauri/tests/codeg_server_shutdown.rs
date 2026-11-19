#![cfg(all(unix, feature = "server-bin", not(feature = "tauri-runtime")))]

use std::net::{SocketAddr, TcpListener, TcpStream};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use codeg_lib::cli_run::discovery::{file_for, DiscoveryRecord};
use futures::StreamExt;
use serde_json::json;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;

const TOKEN: &str = "shutdown-test-token";
const WAIT: Duration = Duration::from_secs(15);
const POLL: Duration = Duration::from_millis(30);

struct ChildPids([PathBuf; 2]);

impl Drop for ChildPids {
    fn drop(&mut self) {
        for file in &self.0 {
            if let Some(pid) = read_pid(file).filter(|&pid| is_running(pid)) {
                unsafe { libc::kill(pid, libc::SIGKILL) };
            }
        }
    }
}

fn read_pid(file: &Path) -> Option<i32> {
    let pid = std::fs::read_to_string(file).ok()?.trim().parse().ok()?;
    (pid > 1).then_some(pid)
}

fn is_running(pid: i32) -> bool {
    let output = Command::new("ps")
        .args(["-o", "stat=", "-p", &pid.to_string()])
        .output()
        .expect("run ps");
    let state = String::from_utf8_lossy(&output.stdout);
    let state = state.trim();
    !state.is_empty() && !state.starts_with('Z')
}

async fn wait_for_pid(path: &Path) -> i32 {
    tokio::time::timeout(WAIT, async {
        loop {
            if let Some(pid) = read_pid(path) {
                return pid;
            }
            tokio::time::sleep(POLL).await;
        }
    })
    .await
    .unwrap_or_else(|_| panic!("{} was not created", path.display()))
}

async fn assert_signal_shuts_down_server(signal: i32) {
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let fake = dir.path().join("opencode");
    // 只替代外部适配器；真正的 HTTP handler、ACP 握手和子进程管理照常执行。
    std::fs::write(
        &fake,
        "#!/bin/sh\ncase \"$1\" in\n\
         --version) echo 2.3.2 ;;\n\
         acp) echo $$ > \"$PWD/acp.pid\"; exec /bin/sleep 120 ;;\n\
         *) exit 1 ;;\nesac\n",
    )
    .unwrap();
    std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
    let child_pids = ChildPids([dir.path().join("terminal.pid"), dir.path().join("acp.pid")]);

    let socket = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = socket.local_addr().unwrap();
    drop(socket);
    let mut server = tokio::process::Command::new(env!("CARGO_BIN_EXE_codeg-server"))
        .env_clear()
        .env("PATH", format!("{}:/usr/bin:/bin", dir.path().display()))
        .env("HOME", dir.path())
        .env("TMPDIR", dir.path())
        .env("CODEG_DATA_DIR", &data)
        .env("CODEG_HOME", &data)
        .env("CODEG_HARNESS", "off")
        .env("CODEG_HOST", "127.0.0.1")
        .env("CODEG_PORT", addr.port().to_string())
        .env("CODEG_TOKEN", TOKEN)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let server_pid = server.id().unwrap();
    let endpoint = file_for(&data, server_pid);
    let api = format!("http://{addr}/api");
    let http = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();
    let cli: DiscoveryRecord = tokio::time::timeout(WAIT, async {
        loop {
            if let Ok(bytes) = std::fs::read(&endpoint) {
                if http
                    .post(format!("{api}/health"))
                    .bearer_auth(TOKEN)
                    .send()
                    .await
                    .is_ok_and(|response| response.status().is_success())
                {
                    break serde_json::from_slice(&bytes).unwrap();
                }
            }
            assert!(
                server.try_wait().unwrap().is_none(),
                "server exited during startup"
            );
            tokio::time::sleep(POLL).await;
        }
    })
    .await
    .expect("server did not start");
    let cli_addr: SocketAddr = cli.url.strip_prefix("http://").unwrap().parse().unwrap();
    assert!(TcpStream::connect(cli_addr).is_ok());

    let mut request = format!("ws://{addr}/ws/events")
        .into_client_request()
        .unwrap();
    request
        .headers_mut()
        .insert("authorization", format!("Bearer {TOKEN}").parse().unwrap());
    let (mut ws, _) = tokio::time::timeout(WAIT, tokio_tungstenite::connect_async(request))
        .await
        .unwrap()
        .unwrap();

    http.post(format!("{api}/terminal_spawn"))
        .bearer_auth(TOKEN)
        .json(&json!({
            "workingDir": dir.path(),
            "shell": "/bin/sh",
            "initialCommand": "echo $$ > terminal.pid; exec /bin/sleep 120",
        }))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    let terminal_pid = wait_for_pid(&child_pids.0[0]).await;

    let response = http
        .post(format!("{api}/acp_connect"))
        .bearer_auth(TOKEN)
        .json(&json!({ "agentType": "open_code", "workingDir": dir.path() }))
        .send()
        .await
        .unwrap();
    assert!(
        response.status().is_success(),
        "ACP launch rejected: {} {:?}",
        response.status(),
        response.text().await
    );
    let acp_pid = wait_for_pid(&child_pids.0[1]).await;
    assert!(is_running(terminal_pid));
    assert!(is_running(acp_pid));

    assert_eq!(unsafe { libc::kill(server_pid as i32, signal) }, 0);
    tokio::time::timeout(WAIT, async {
        while let Some(frame) = ws.next().await {
            if matches!(frame.unwrap(), Message::Close(_)) {
                return;
            }
        }
        panic!("WebSocket ended without a close frame");
    })
    .await
    .expect("WebSocket did not close during shutdown");
    let status = tokio::time::timeout(WAIT, server.wait())
        .await
        .unwrap()
        .unwrap();
    assert!(status.success(), "signal {signal}: {status}");
    assert!(!endpoint.exists());
    assert!(TcpStream::connect(addr).is_err());
    assert!(TcpStream::connect(cli_addr).is_err());
    assert!(
        !is_running(terminal_pid),
        "terminal {terminal_pid} still running"
    );
    assert!(!is_running(acp_pid), "ACP {acp_pid} still running");
}

#[tokio::test]
async fn sigint_and_sigterm_clean_up_listeners_and_children() {
    for signal in [libc::SIGINT, libc::SIGTERM] {
        assert_signal_shuts_down_server(signal).await;
    }
}
