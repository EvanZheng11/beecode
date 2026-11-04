//! 通过真实 Axum 路由验证监控契约；仅使用内存数据库，不操作实际进程。

use std::sync::Arc;

use axum_test::TestServer;
use codeg_lib::app_state::AppState;
use codeg_lib::db::test_helpers::fresh_in_memory_db;
use codeg_lib::web::router::build_router;
use codeg_lib::web::shutdown::ShutdownSignal;
use serde_json::{json, Value};

const TOKEN: &str = "resource-monitor-integration-test";

async fn server() -> (TestServer, tempfile::TempDir, tempfile::TempDir) {
    let data = tempfile::tempdir().unwrap();
    let assets = tempfile::tempdir().unwrap();
    let db = fresh_in_memory_db().await;
    let state = Arc::new(AppState::new_for_test(db, data.path().to_path_buf()));
    let router = build_router(
        state,
        TOKEN.to_owned(),
        assets.path().to_path_buf(),
        Arc::new(ShutdownSignal::new()),
    );
    (TestServer::new(router).unwrap(), data, assets)
}

#[tokio::test]
async fn monitor_routes_require_authentication() {
    let (server, _data, _assets) = server().await;
    for path in [
        "/api/resource-monitor/settings",
        "/api/resource-monitor/snapshot",
    ] {
        assert_eq!(server.get(path).await.status_code(), 401);
    }
    assert_eq!(
        server
            .put("/api/resource-monitor/settings")
            .json(&json!({"enabled": true}))
            .await
            .status_code(),
        401
    );
    assert_eq!(
        server
            .post("/api/resource-monitor/action")
            .json(&json!({"pid": 0, "startTime": 0, "action": "kill"}))
            .await
            .status_code(),
        401
    );
}

#[tokio::test]
async fn monitor_defaults_disabled_and_returns_empty_snapshot() {
    let (server, _data, _assets) = server().await;
    let settings = server
        .get("/api/resource-monitor/settings")
        .add_header("authorization", format!("Bearer {TOKEN}"))
        .await;
    assert_eq!(settings.status_code(), 200);
    assert_eq!(settings.json::<Value>(), json!({"enabled": false}));

    let response = server
        .get("/api/resource-monitor/snapshot")
        .add_header("authorization", format!("Bearer {TOKEN}"))
        .await;
    assert_eq!(response.status_code(), 200);
    let snapshot = response.json::<Value>();
    assert_eq!(snapshot["enabled"], false);
    assert_eq!(snapshot["processes"], json!([]));
    assert_eq!(snapshot["activeProcessCount"], 0);
    assert_eq!(snapshot["totalMemoryBytes"], 0);
    assert!(snapshot["sampleIntervalMs"].as_u64().unwrap() >= 2000);
}

#[tokio::test]
async fn disabled_monitor_rejects_process_actions_and_invalid_actions() {
    let (server, _data, _assets) = server().await;
    let rejected = server
        .post("/api/resource-monitor/action")
        .add_header("authorization", format!("Bearer {TOKEN}"))
        .json(&json!({"pid": 0, "startTime": 0, "action": "kill"}))
        .await;
    assert!(rejected.status_code().is_client_error());
    let invalid = server
        .post("/api/resource-monitor/action")
        .add_header("authorization", format!("Bearer {TOKEN}"))
        .json(&json!({"pid": 0, "startTime": 0, "action": "execute"}))
        .await;
    assert!(invalid.status_code().is_client_error());
}
