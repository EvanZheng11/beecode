use super::*;
use crate::commands::remote_mention::*;
use crate::db::test_helpers::fresh_in_memory_db;
use crate::models::RemoteWorkspaceHeader;
use axum::{
    extract::{Path, State},
    http::HeaderMap,
    response::IntoResponse,
    routing::post,
    Json, Router,
};
use std::sync::Arc;

#[test]
fn public_http_distinguishes_private_ranges() {
    for url in [
        "http://127.0.0.2",
        "http://localhost",
        "http://a.local.",
        "http://10.1.2.3",
        "http://172.16.0.1",
        "http://172.31.255.255",
        "http://192.168.1.1",
        "http://100.64.0.1",
        "http://100.127.255.255",
        "http://[::1]",
        "http://[fc00::1]",
        "http://[fdff::1]",
        "http://[::ffff:192.168.1.1]",
        "https://example.com",
    ] {
        assert!(!is_public_http(url), "{url}");
    }
    for url in [
        "http://example.com",
        "http://8.8.8.8",
        "http://172.32.0.1",
        "http://100.63.255.255",
        "http://100.128.0.1",
        "http://[2606:4700::1111]",
    ] {
        assert!(is_public_http(url), "{url}");
    }
}

#[test]
fn errors_keep_legacy_and_cli_contracts() {
    let unauthorized = map_error(StatusCode::UNAUTHORIZED, "do not echo this");
    assert!(matches!(
        unauthorized.code,
        AppErrorCode::AuthenticationFailed
    ));
    assert!(unauthorized.detail.is_none());
    let body = json!({"subtype":"error_runtime_unavailable", "error":{"code":"run_not_found", "message":"gone"}}).to_string();
    let missing = map_error(StatusCode::NOT_FOUND, &body);
    assert!(matches!(missing.code, AppErrorCode::NotFound));
    assert_eq!(
        serde_json::from_str::<Value>(missing.detail.as_deref().unwrap()).unwrap()["code"],
        "run_not_found"
    );
    let body = json!({"subtype":"error_usage", "error":{"code":"run_not_reserved", "message":"reserve first"}}).to_string();
    let conflict = map_error(StatusCode::CONFLICT, &body);
    assert_eq!(conflict.message, "reserve first");
    assert_eq!(
        serde_json::from_str::<Value>(conflict.detail.as_deref().unwrap()).unwrap()["http_status"],
        409
    );
    let original =
        AppCommandError::invalid_input("bad").with_i18n("errors.bad", Default::default());
    let mapped = map_error(
        StatusCode::BAD_REQUEST,
        &serde_json::to_string(&original).unwrap(),
    );
    assert_eq!(
        serde_json::to_value(mapped).unwrap(),
        serde_json::to_value(original).unwrap()
    );
    assert_eq!(
        map_error(StatusCode::BAD_GATEWAY, "legacy body")
            .detail
            .as_deref(),
        Some("legacy body")
    );
}

#[test]
fn legacy_monitor_mapping_and_timeout_ceiling() {
    assert_eq!(
        route("get_resource_monitor_settings"),
        (Method::GET, "resource-monitor/settings")
    );
    assert_eq!(
        route("get_resource_monitor_snapshot"),
        (Method::GET, "resource-monitor/snapshot")
    );
    assert_eq!(
        route("set_resource_monitor_enabled"),
        (Method::PUT, "resource-monitor/settings")
    );
    assert_eq!(
        route("resource_monitor_process_action"),
        (Method::POST, "resource-monitor/action")
    );
    assert_eq!(route("/other"), (Method::POST, "other"));
    assert_eq!(timeout(None), Duration::from_secs(30));
    assert_eq!(timeout(Some(u64::MAX)), Duration::from_secs(600));
    assert_eq!(timeout(Some(70_000)), Duration::from_secs(70));
}

#[derive(Clone)]
struct Mock {
    token: Arc<Mutex<String>>,
    calls: Arc<Mutex<Vec<(String, HeaderMap, Value)>>>,
    bad_proof: bool,
    runtime: &'static str,
}

async fn handler(
    State(mock): State<Mock>,
    Path(command): Path<String>,
    headers: HeaderMap,
    Json(args): Json<Value>,
) -> axum::response::Response {
    mock.calls
        .lock()
        .await
        .push((command.clone(), headers.clone(), args.clone()));
    if command == "cli_hello" {
        let token = mock.token.lock().await.clone();
        return Json(json!({"proof": if mock.bad_proof { "wrong".to_owned() } else { hello_proof::proof(&token, args["nonce"].as_str().unwrap(), None) },
            "runtime": mock.runtime, "build":"release", "version":"0.42.4", "apiVersion":1, "capabilities":["run"]})).into_response();
    }
    assert_eq!(
        headers.get("authorization").unwrap(),
        &format!("Bearer {}", *mock.token.lock().await)
    );
    let value = match command.as_str() {
        "list_all_folder_details" => {
            json!([{"id":7,"name":"project","path":"/registered","alias":null,"parent_id":null}])
        }
        "list_workspace_files" => {
            assert_eq!(args, json!({"path":"/registered"}));
            Value::Array((0..20_001).map(|i| json!({"name":format!("{i}.rs"),"path":format!("src/{i}.rs"),"kind":"file"})).collect())
        }
        "list_all_conversations" => {
            assert_eq!(args["folderIds"], json!([7]));
            json!([{"id":9,"folder_id":7,"agent_type":"codex","title":"s","message_count":1}])
        }
        "cli_agents" => {
            json!([{"slug":"yes","name":"Y","enabled":true,"installed":true,"install_hint":"hint"}, {"slug":"no","name":"N","enabled":true,"installed":false}])
        }
        "cli_assistants" => json!([{"id":2,"name":"A","agent":"codex","description":"d"}]),
        "cli_run_get" => {
            return (
                StatusCode::TEMPORARY_REDIRECT,
                [("location", "/api/cli_agents")],
            )
                .into_response()
        }
        _ => json!({}),
    };
    Json(value).into_response()
}

async fn mock_server(
    bad_proof: bool,
    runtime: &'static str,
) -> (Mock, String, tokio::task::JoinHandle<()>) {
    let mock = Mock {
        token: Arc::new(Mutex::new("test-only-token".into())),
        calls: Default::default(),
        bad_proof,
        runtime,
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let router = Router::new()
        .route("/api/{command}", post(handler))
        .with_state(mock.clone());
    let task = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    (mock, url, task)
}

#[tokio::test]
async fn whitelist_rejects_paths_before_database_or_network() {
    let db = fresh_in_memory_db().await;
    for command in [
        "read_file_base64",
        "/cli_agents",
        "../cli_agents",
        "cli_agents?x",
        "cli_agents/..",
        "%63li_agents",
        "https://other/api/cli_agents",
    ] {
        let error = call_allowed(&db, 999, command, None, None)
            .await
            .unwrap_err();
        assert!(
            matches!(error.code, AppErrorCode::PermissionDenied),
            "{command}"
        );
    }
    assert_eq!(ALLOWED_ROUTES.len(), 14);
}

#[tokio::test]
async fn failed_proof_sends_no_credentials_or_followup() {
    let (mock, url, task) = mock_server(true, "server").await;
    let db = fresh_in_memory_db().await;
    let conn = remote_workspace_connection_service::create(
        &db.conn,
        "bad",
        &url,
        "test-only-token",
        &[RemoteWorkspaceHeader {
            name: "x-secret".into(),
            value: "secret".into(),
        }],
    )
    .await
    .unwrap();
    let error = call_allowed(&db, conn.id, "cli_agents", None, None)
        .await
        .unwrap_err();
    assert!(matches!(error.code, AppErrorCode::AuthenticationFailed));
    let calls = mock.calls.lock().await;
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].0, "cli_hello");
    assert!(!calls[0].1.contains_key("authorization"));
    assert!(!calls[0].1.contains_key("x-secret"));
    task.abort();
}

#[tokio::test]
async fn authenticated_lists_cache_invalidate_and_preserve_wire_names() {
    let (mock, url, task) = mock_server(false, "desktop").await;
    let db = fresh_in_memory_db().await;
    let headers = vec![RemoteWorkspaceHeader {
        name: "x-secret".into(),
        value: "one".into(),
    }];
    let conn = remote_workspace_connection_service::create(
        &db.conn,
        "test",
        &url,
        "test-only-token",
        &headers,
    )
    .await
    .unwrap();
    let caps = remote_mention_probe_core(&db, conn.id).await.unwrap();
    assert_eq!(
        serde_json::to_value(caps).unwrap(),
        json!({"runtime":"desktop","version":"0.42.4","apiVersion":1,"capabilities":["run"]})
    );
    let folders = remote_mention_list_folders_core(&db, conn.id)
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_value(folders).unwrap(),
        json!([{"id":7,"name":"project","path":"/registered","alias":null}])
    );
    let files = remote_mention_list_files_core(&db, conn.id, 7)
        .await
        .unwrap();
    assert_eq!(files.entries.len(), 20_000);
    assert!(files.truncated);
    remote_mention_list_files_core(&db, conn.id, 7)
        .await
        .unwrap();
    assert!(remote_mention_list_files_core(&db, conn.id, 999)
        .await
        .is_err());
    let sessions = remote_mention_list_sessions_core(&db, conn.id, 7, Some("s".into()))
        .await
        .unwrap();
    assert_eq!(sessions[0]["folder_id"], 7);
    assert!(sessions[0].get("folderId").is_none());
    let agents = remote_mention_list_agents_core(&db, conn.id).await.unwrap();
    assert_eq!(agents.len(), 1);
    assert_eq!(
        serde_json::to_value(agents).unwrap()[0]["install_hint"],
        "hint"
    );
    assert_eq!(
        remote_mention_list_assistants_core(&db, conn.id)
            .await
            .unwrap()[0]
            .agent,
        "codex"
    );
    let calls = mock.calls.lock().await.clone();
    assert_eq!(calls.iter().filter(|c| c.0 == "cli_hello").count(), 1);
    assert_eq!(
        calls
            .iter()
            .filter(|c| c.0 == "list_workspace_files")
            .count(),
        1
    );
    assert!(!calls[0].1.contains_key("authorization"));
    assert_eq!(calls[1].1["x-secret"], "one");
    // headers、token、base_url 任一变化都必须重新 hello，不能命中列表缓存。
    let headers = vec![RemoteWorkspaceHeader {
        name: "x-secret".into(),
        value: "two".into(),
    }];
    remote_workspace_connection_service::update(
        &db.conn,
        conn.id,
        "test",
        &url,
        "test-only-token",
        &headers,
    )
    .await
    .unwrap();
    remote_mention_list_agents_core(&db, conn.id).await.unwrap();
    *mock.token.lock().await = "new-token".into();
    remote_workspace_connection_service::update(
        &db.conn,
        conn.id,
        "test",
        &url,
        "new-token",
        &headers,
    )
    .await
    .unwrap();
    remote_mention_list_agents_core(&db, conn.id).await.unwrap();
    remote_workspace_connection_service::update(
        &db.conn,
        conn.id,
        "test",
        &format!("{url}/"),
        "new-token",
        &headers,
    )
    .await
    .unwrap();
    // service 会去掉尾斜杠；显式更换 origin 才改变身份。
    let (other, other_url, other_task) = mock_server(false, "server").await;
    remote_workspace_connection_service::update(
        &db.conn,
        conn.id,
        "test",
        &other_url,
        "test-only-token",
        &headers,
    )
    .await
    .unwrap();
    assert!(matches!(
        hello(&db, conn.id).await.unwrap().runtime,
        wire::RuntimeKind::Server
    ));
    assert_eq!(other.calls.lock().await.len(), 1);
    assert_eq!(
        mock.calls
            .lock()
            .await
            .iter()
            .filter(|c| c.0 == "cli_hello")
            .count(),
        3
    );
    // 新功能不跟随同源重定向，避免绕开固定命令。
    assert!(call_allowed(&db, conn.id, "cli_run_get", None, None)
        .await
        .is_err());
    assert_eq!(other.calls.lock().await.len(), 2);
    task.abort();
    other_task.abort();
}

#[tokio::test]
async fn legacy_call_does_not_require_hello() {
    let (mock, url, task) = mock_server(true, "server").await;
    let db = fresh_in_memory_db().await;
    let conn = remote_workspace_connection_service::create(
        &db.conn,
        "legacy",
        &url,
        "test-only-token",
        &[],
    )
    .await
    .unwrap();
    assert_eq!(
        call_any(&db, conn.id, "old_command", Some(json!({"x":1})), None)
            .await
            .unwrap(),
        json!({})
    );
    let calls = mock.calls.lock().await;
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].0, "old_command");
    assert_eq!(calls[0].2, json!({"x":1}));
    task.abort();
}
