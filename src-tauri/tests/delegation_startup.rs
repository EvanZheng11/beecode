//! 委派栈必须覆盖桌面同步 setup 与服务器异步启动两种运行时边界。
#![cfg(feature = "test-utils")]

use codeg_lib::app_state::{build_delegation_stack, default_connection_manager};
use codeg_lib::db::test_helpers;

#[cfg(feature = "tauri-runtime")]
#[test]
fn desktop_setup_builds_delegation_stack_without_entered_tokio_runtime() {
    // 不创建窗口、不启动应用，也不读取正式数据库。
    assert!(tokio::runtime::Handle::try_current().is_err());
    let data_dir = tempfile::tempdir().unwrap();
    let db = tauri::async_runtime::block_on(test_helpers::fresh_in_memory_db());
    // block_on 返回后仍在普通同步线程，和 Tauri setup 的调用环境一致。
    assert!(tokio::runtime::Handle::try_current().is_err());
    let manager = default_connection_manager();
    let _stack = build_delegation_stack(&manager, db.conn, data_dir.path().to_path_buf());
    assert!(tokio::runtime::Handle::try_current().is_err());
}

#[cfg(not(feature = "tauri-runtime"))]
#[tokio::test]
async fn server_startup_builds_delegation_stack_inside_tokio_runtime() {
    let data_dir = tempfile::tempdir().unwrap();
    let db = test_helpers::fresh_in_memory_db().await;
    let manager = default_connection_manager();
    let _stack = build_delegation_stack(&manager, db.conn, data_dir.path().to_path_buf());
}
