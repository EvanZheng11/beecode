//! 仅使用临时数据库、假 token 和回环 HTTP；不访问真实仓库或凭据。
#![cfg(all(unix, not(feature = "tauri-runtime")))]

use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::Duration;

use codeg_lib::db::service::app_metadata_service;
use codeg_lib::git_credential::{create_credential_helper_script, try_inject_for_repo_remote};

struct MockHttp {
    port: u16,
    requests: Arc<Mutex<Vec<String>>>,
    stop: Arc<AtomicBool>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl MockHttp {
    fn new(redirect: Option<String>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        listener.set_nonblocking(true).unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let captured = requests.clone();
        let stopped = stop.clone();
        let thread = std::thread::spawn(move || {
            while !stopped.load(Ordering::Relaxed) {
                let (mut stream, _) = match listener.accept() {
                    Ok(pair) => pair,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(5));
                        continue;
                    }
                    Err(e) => panic!("mock accept: {e}"),
                };
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut request = Vec::new();
                let mut buf = [0; 2048];
                while request.len() < 16384 && !request.ends_with(b"\r\n\r\n") {
                    let n = stream.read(&mut buf).unwrap();
                    if n == 0 {
                        break;
                    }
                    request.extend_from_slice(&buf[..n]);
                }
                let request = String::from_utf8(request).unwrap();
                let authenticated = request.to_lowercase().contains("authorization: basic ");
                captured.lock().unwrap().push(request);
                let response = if !authenticated {
                    "HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=mock\r\n"
                        .to_string()
                } else if let Some(target) = &redirect {
                    format!("HTTP/1.1 302 Found\r\nLocation: {target}\r\n")
                } else {
                    "HTTP/1.1 404 Not Found\r\n".to_string()
                };
                let _ = write!(
                    stream,
                    "{response}Content-Length: 0\r\nConnection: close\r\n\r\n"
                );
            }
        });
        Self {
            port,
            requests,
            stop,
            thread: Some(thread),
        }
    }

    fn clear(&self) {
        self.requests.lock().unwrap().clear();
    }

    fn authenticated_as(&self, username: &str, token: &str) -> bool {
        use base64::Engine;
        let expected = format!(
            "authorization: basic {}",
            base64::engine::general_purpose::STANDARD.encode(format!("{username}:{token}"))
        )
        .to_lowercase();
        self.requests
            .lock()
            .unwrap()
            .iter()
            .any(|r| r.to_lowercase().contains(&expected))
    }
}

impl Drop for MockHttp {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        self.thread.take().unwrap().join().unwrap();
    }
}

fn isolated_git(repo: &std::path::Path) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new("git");
    cmd.env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap())
        .env("HOME", repo)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("LC_ALL", "C")
        .current_dir(repo);
    cmd
}

#[tokio::test]
async fn stored_credentials_follow_upstream_pushurl_and_fetch_all_without_cross_host_leaks() {
    let tmp = tempfile::tempdir().unwrap();
    let repo = tmp.path().join("repo");
    let data = tmp.path().join("data");
    std::fs::create_dir_all(&repo).unwrap();
    let first = MockHttp::new(None);
    let second = MockHttp::new(None);
    let unrelated = MockHttp::new(None);
    let first_url = format!("http://127.0.0.1:{}/repo", first.port);
    let second_url = format!("http://localhost:{}/repo", second.port);
    let unrelated_url = format!("http://127.0.0.1:{}/repo", unrelated.port);
    let redirect = MockHttp::new(Some(second_url.clone()));
    let redirect_url = format!("http://127.0.0.1:{}/repo", redirect.port);
    let db = codeg_lib::db::init_database(&data, "test").await.unwrap();
    let accounts = serde_json::json!({"accounts": [
        {"id":"a", "server_url":first_url, "username":"alice", "scopes":[], "is_default":true, "created_at":""},
        {"id":"b", "server_url":second_url, "username":"bob", "scopes":[], "is_default":false, "created_at":""},
        {"id":"c", "server_url":redirect_url, "username":"carol", "scopes":[], "is_default":false, "created_at":""}
    ]});
    app_metadata_service::upsert_value(&db.conn, "github_accounts", &accounts.to_string())
        .await
        .unwrap();
    let tokens =
        serde_json::json!({"github-token:a":"fake-a", "github-token:b":"fake-b", "github-token:c":"fake-c"}).to_string();
    std::fs::write(data.join("tokens.json"), &tokens).unwrap();

    for args in [
        vec!["init", "-b", "main"],
        vec![
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "commit",
            "--allow-empty",
            "-m",
            "test",
        ],
        vec!["remote", "add", "origin", &first_url],
        vec!["remote", "add", "upstream", &second_url],
        vec!["remote", "add", "unrelated", &unrelated_url],
        vec!["remote", "add", "redirect", &redirect_url],
        vec!["config", "branch.main.remote", "upstream"],
        vec!["config", "branch.main.merge", "refs/heads/main"],
        vec!["config", "remote.origin.pushurl", &second_url],
        vec![
            "config",
            "credential.helper",
            "!f() { echo username=stale; echo password=stale; }; f",
        ],
    ] {
        assert!(isolated_git(&repo)
            .args(args)
            .output()
            .await
            .unwrap()
            .status
            .success());
    }
    for args in [
        vec!["fetch"],
        vec!["fetch", "--all"],
        vec!["push", "--dry-run", "origin", "HEAD"],
    ] {
        first.clear();
        second.clear();
        unrelated.clear();
        redirect.clear();
        let mut cmd = isolated_git(&repo);
        cmd.args(&args);
        assert!(
            try_inject_for_repo_remote(&mut cmd, repo.to_str().unwrap(), None, &db.conn, &data)
                .await
        );
        // 测试进程不是应用入口；将同一生成脚本指向真实 server helper 入口。
        create_credential_helper_script(
            &data,
            std::path::Path::new(env!("CARGO_BIN_EXE_codeg-server")),
        )
        .unwrap();
        let output = tokio::time::timeout(Duration::from_secs(30), cmd.output())
            .await
            .unwrap()
            .unwrap();
        // mock 在认证后返回 404；验证认证路由，不模拟完整 Git wire protocol。
        assert!(!output.status.success());
        assert!(
            second.authenticated_as("bob", "fake-b"),
            "{args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(!second.authenticated_as("alice", "fake-a"));
        assert!(!first.authenticated_as("bob", "fake-b"));
        assert!(!unrelated
            .requests
            .lock()
            .unwrap()
            .iter()
            .any(|r| r.to_lowercase().contains("authorization:")));
        if args.contains(&"--all") {
            assert!(first.authenticated_as("alice", "fake-a"));
            assert!(redirect.authenticated_as("carol", "fake-c"));
            assert!(!second.authenticated_as("carol", "fake-c"));
            assert_eq!(
                second
                    .requests
                    .lock()
                    .unwrap()
                    .iter()
                    .filter(|r| r.starts_with("GET /repo/info/refs"))
                    .count(),
                2,
                "重定向不得抵达第二个 host"
            );
        } else {
            assert!(
                first.requests.lock().unwrap().is_empty(),
                "默认 fetch 应使用 upstream，push 应使用 pushurl"
            );
        }
    }
    assert_eq!(
        std::fs::read_to_string(data.join("tokens.json")).unwrap(),
        tokens
    );
    assert!(!repo.join(".git-credentials").exists());
}
