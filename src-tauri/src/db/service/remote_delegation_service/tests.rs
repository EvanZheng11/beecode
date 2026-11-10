use super::*;
use crate::db::entities::{conversation, remote_mention_grant, remote_workspace_connection};
use crate::db::migration::Migrator;
use crate::db::service::remote_mention_grant_service as grants;
use crate::db::test_helpers::{fresh_in_memory_db, seed_conversation, seed_folder};
use crate::models::agent::AgentType;
use sea_orm::{ConnectionTrait, DbBackend, PaginatorTrait, Statement};
use sea_orm_migration::{MigratorTrait, SchemaManager};

async fn fixture() -> (crate::db::AppDatabase, i32, i32, i32) {
    let db = fresh_in_memory_db().await;
    let folder = seed_folder(&db, "/tmp/remote-db-tests").await;
    let parent = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
    let fork = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
    conversation::Entity::update_many()
        .col_expr(conversation::Column::ParentId, Expr::value(parent))
        .filter(conversation::Column::Id.eq(fork))
        .exec(&db.conn)
        .await
        .unwrap();
    let now = Utc::now();
    let connection = remote_workspace_connection::ActiveModel {
        name: Set("远程机器".into()),
        base_url: Set("https://remote.test".into()),
        token: Set("test-only".into()),
        headers: Set("[]".into()),
        sort_order: Set(0),
        created_at: Set(now),
        updated_at: Set(now),
        ..Default::default()
    }
    .insert(&db.conn)
    .await
    .unwrap()
    .id;
    (db, parent, fork, connection)
}

fn input(task: &str, parent: i32, connection: i32) -> NewRemoteDelegation {
    NewRemoteDelegation {
        task_id: task.into(),
        connection_id: connection,
        parent_conversation_id: parent,
        parent_tool_use_id: format!("tool-{task}"),
        connection_name: "远程机器".into(),
        remote_folder_id: 12345,
        remote_workspace: "/remote/project".into(),
        target_kind: "agent".into(),
        target_ref: "codex".into(),
        target_label: "Codex".into(),
        permissions: "wait".into(),
        task_preview: "任务摘要".repeat(200),
    }
}

#[tokio::test]
async fn remote_mention_migration_up_down_and_schema() {
    let db = fresh_in_memory_db().await;
    let manager = SchemaManager::new(&db.conn);
    assert!(manager.has_table("remote_delegation").await.unwrap());
    assert!(manager.has_table("remote_mention_grant").await.unwrap());
    let columns = db
        .conn
        .query_all(Statement::from_string(
            DbBackend::Sqlite,
            "PRAGMA table_info(remote_delegation)".to_owned(),
        ))
        .await
        .unwrap();
    assert_eq!(columns.len(), 28);
    for name in ["run_id", "connection_id", "settled_at"] {
        let col = columns
            .iter()
            .find(|c| c.try_get::<String>("", "name").unwrap() == name)
            .unwrap();
        assert_eq!(col.try_get::<i32>("", "notnull").unwrap(), 0);
    }
    let indexes = db.conn.query_all(Statement::from_string(DbBackend::Sqlite, "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name IN ('remote_delegation','remote_mention_grant')".to_owned())).await.unwrap();
    assert_eq!(indexes.len(), 6);
    Migrator::down(&db.conn, Some(1)).await.unwrap();
    assert!(!manager.has_table("remote_delegation").await.unwrap());
    assert!(!manager.has_table("remote_mention_grant").await.unwrap());
    assert!(manager.has_table("conversation").await.unwrap());
    assert!(manager
        .has_table("remote_workspace_connection")
        .await
        .unwrap());
    Migrator::up(&db.conn, None).await.unwrap();
    assert!(manager.has_table("remote_delegation").await.unwrap());
    assert!(manager.has_table("remote_mention_grant").await.unwrap());
}

#[tokio::test]
async fn remote_grants_upsert_fork_and_foreign_keys() {
    let (db, parent, fork, connection) = fixture().await;
    grants::upsert(&db.conn, parent, connection, 12345)
        .await
        .unwrap();
    let first = grants::list_by_conversation(&db.conn, parent)
        .await
        .unwrap()
        .remove(0);
    // 把最近时间设为过去，不依赖 sleep 或时钟精度。
    remote_mention_grant::Entity::update_many()
        .col_expr(
            remote_mention_grant::Column::LastMentionedAt,
            Expr::value(Utc::now() - Duration::days(1)),
        )
        .exec(&db.conn)
        .await
        .unwrap();
    grants::upsert(&db.conn, parent, connection, 12345)
        .await
        .unwrap();
    let rows = grants::list_by_conversation(&db.conn, parent)
        .await
        .unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].id, first.id);
    assert_eq!(rows[0].created_at, first.created_at);
    assert!(rows[0].last_mentioned_at >= first.last_mentioned_at);
    assert!(grants::is_granted(&db.conn, parent, connection, 12345)
        .await
        .unwrap());
    assert!(!grants::is_granted(&db.conn, fork, connection, 12345)
        .await
        .unwrap());
    assert!(!grants::is_granted(&db.conn, parent, connection, 999)
        .await
        .unwrap());
    assert!(grants::upsert(&db.conn, parent, connection, 0)
        .await
        .is_err());
    assert!(grants::upsert(&db.conn, parent, connection + 100, 1)
        .await
        .is_err());

    create_reserving(&db.conn, &input("history", parent, connection))
        .await
        .unwrap();
    remote_workspace_connection::Entity::delete_by_id(connection)
        .exec(&db.conn)
        .await
        .unwrap();
    assert!(grants::list_by_conversation(&db.conn, parent)
        .await
        .unwrap()
        .is_empty());
    let history = get_by_task_id(&db.conn, "history").await.unwrap().unwrap();
    assert_eq!(history.connection_id, None);
    assert_eq!(history.connection_name, "远程机器");
    conversation::Entity::delete_by_id(parent)
        .exec(&db.conn)
        .await
        .unwrap();
    assert!(get_by_task_id(&db.conn, "history").await.unwrap().is_none());

    let (db, parent, _, connection) = fixture().await;
    grants::upsert(&db.conn, parent, connection, 1)
        .await
        .unwrap();
    conversation::Entity::delete_by_id(parent)
        .exec(&db.conn)
        .await
        .unwrap();
    assert_eq!(
        remote_mention_grant::Entity::find()
            .count(&db.conn)
            .await
            .unwrap(),
        0
    );
}

#[tokio::test]
async fn remote_tasks_states_recovery_cursor_and_terminal_races() {
    let (db, parent, fork, connection) = fixture().await;
    for state in NON_TERMINAL_STATUSES.into_iter().chain(TERMINAL_STATUSES) {
        let row = create_reserving(&db.conn, &input(state, parent, connection))
            .await
            .unwrap();
        assert!(row.run_id.is_none());
        assert_eq!(row.task_preview.chars().count(), 500);
        if state != "reserving" {
            assert!(update_run_id(&db.conn, state, "run-1").await.unwrap());
            assert!(mark_started(
                &db.conn,
                state,
                &StartedRemoteDelegation {
                    remote_conversation_id: Some(88888),
                    remote_link: Some("codeg://session/88888".into()),
                    remote_worktree: Some(
                        "{\"path\":\"/remote/wt\",\"branch\":\"cli/test\"}".into()
                    )
                }
            )
            .await
            .unwrap());
            if TERMINAL_STATUSES.contains(&state) {
                assert!(settle(&db.conn, state, state, &TerminalUpdate::default())
                    .await
                    .unwrap());
            } else {
                assert!(update_progress(
                    &db.conn,
                    state,
                    state,
                    if state == "blocked" {
                        Some("question")
                    } else {
                        None
                    },
                    5
                )
                .await
                .unwrap());
            }
        }
    }
    assert!(
        create_reserving(&db.conn, &input("reserving", parent, connection))
            .await
            .is_err()
    );
    create_reserving(&db.conn, &input("other-parent", fork, connection))
        .await
        .unwrap();
    let recovered = list_for_recovery(&db.conn).await.unwrap();
    assert_eq!(recovered.len(), 5);
    for state in NON_TERMINAL_STATUSES {
        assert!(recovered.iter().any(|r| r.status == state));
    }
    assert_eq!(
        list_unsettled_by_connection(&db.conn, connection)
            .await
            .unwrap()
            .len(),
        5
    );
    assert!(list_unsettled_by_connection(&db.conn, connection + 1)
        .await
        .unwrap()
        .is_empty());
    assert_eq!(
        list_by_parent_conversation(&db.conn, parent)
            .await
            .unwrap()
            .len(),
        7
    );
    assert!(
        !mark_started(&db.conn, "reserving", &StartedRemoteDelegation::default())
            .await
            .unwrap()
    );
    assert!(update_event_cursor(&db.conn, "running", 10).await.unwrap());
    assert!(!update_event_cursor(&db.conn, "running", 9).await.unwrap());
    assert!(
        !update_progress(&db.conn, "running", "blocked", Some("permission"), 8)
            .await
            .unwrap()
    );
    assert!(
        update_progress(&db.conn, "running", "blocked", Some("permission"), 10)
            .await
            .unwrap()
    );
    assert!(update_progress(&db.conn, "running", "running", None, -1)
        .await
        .is_err());
    assert!(update_progress(&db.conn, "running", "completed", None, 11)
        .await
        .is_err());
    assert!(update_progress(&db.conn, "running", "blocked", None, 11)
        .await
        .is_err());
    let terminal = TerminalUpdate {
        result_text: Some("中🙂".repeat(60000)),
        error_message: Some("错误🙂".repeat(1000)),
        error_code: Some("remote_run_lost".into()),
        result_subtype: Some("error".into()),
        duration_ms: Some(100),
        last_event_seq: 3,
    };
    assert!(settle(&db.conn, "running", "failed", &terminal)
        .await
        .unwrap());
    let row = get_by_task_id(&db.conn, "running").await.unwrap().unwrap();
    assert_eq!(row.last_event_seq, 10);
    assert!(row.blocked_on.is_none());
    assert!(row.settled_at.is_some());
    assert_eq!(row.duration_ms, Some(100));
    for (text, limit) in [
        (row.result_text.as_ref().unwrap(), MAX_RESULT_BYTES),
        (row.error_message.as_ref().unwrap(), MAX_ERROR_BYTES),
    ] {
        assert!(text.len() <= limit);
        assert!(text.ends_with(TRUNCATED));
    }
    assert!(
        !settle(&db.conn, "running", "canceled", &TerminalUpdate::default())
            .await
            .unwrap()
    );
    assert!(!update_progress(&db.conn, "running", "running", None, 99)
        .await
        .unwrap());
    assert!(!update_event_cursor(&db.conn, "running", 99).await.unwrap());
    assert!(!update_run_id(&db.conn, "running", "late").await.unwrap());
    assert_eq!(
        get_by_task_id(&db.conn, "running").await.unwrap().unwrap(),
        row
    );
    assert_eq!(truncate_utf8("中🙂", 100), "中🙂");
}

#[tokio::test]
async fn remote_cleanup_retains_live_recent_and_boundary_rows_caps_at_1000() {
    let (db, parent, _, connection) = fixture().await;
    let now = Utc::now();
    let template = create_reserving(&db.conn, &input("template", parent, connection))
        .await
        .unwrap();
    // 使用批量插入保持测试快速，全部数据只存在于内存库。
    let mut rows = Vec::new();
    for n in 0..1002 {
        let mut active: remote_delegation::ActiveModel = template.clone().into();
        active.id = sea_orm::ActiveValue::NotSet;
        active.task_id = Set(format!("old-{n}"));
        active.status = Set("completed".into());
        active.settled_at = Set(Some(now - Duration::days(91)));
        rows.push(active);
    }
    for chunk in rows.chunks(20) {
        Entity::insert_many(chunk.to_vec())
            .exec(&db.conn)
            .await
            .unwrap();
    }
    for (task, age) in [("boundary", 90), ("recent", 1)] {
        create_reserving(&db.conn, &input(task, parent, connection))
            .await
            .unwrap();
        settle(&db.conn, task, "completed", &TerminalUpdate::default())
            .await
            .unwrap();
        Entity::update_many()
            .col_expr(Column::SettledAt, Expr::value(now - Duration::days(age)))
            .filter(Column::TaskId.eq(task))
            .exec(&db.conn)
            .await
            .unwrap();
    }
    // 即使非终态意外带有旧 settled_at，也不能被清理。
    Entity::update_many()
        .col_expr(Column::SettledAt, Expr::value(now - Duration::days(100)))
        .filter(Column::TaskId.eq("template"))
        .exec(&db.conn)
        .await
        .unwrap();
    assert_eq!(cleanup_settled(&db.conn, now).await.unwrap(), 1000);
    assert_eq!(cleanup_settled(&db.conn, now).await.unwrap(), 2);
    assert_eq!(cleanup_settled(&db.conn, now).await.unwrap(), 0);
    assert_eq!(Entity::find().count(&db.conn).await.unwrap(), 3);
}
