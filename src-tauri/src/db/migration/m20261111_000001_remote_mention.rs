use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // 与设计 SQL 保持一致：仅新增两表，不改已有表。
        manager.get_connection().execute_unprepared(r#"
CREATE TABLE IF NOT EXISTS remote_delegation (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    connection_id INTEGER NULL,
    parent_conversation_id INTEGER NOT NULL,
    parent_tool_use_id TEXT NOT NULL,
    connection_name TEXT NOT NULL,
    remote_folder_id INTEGER NOT NULL,
    remote_workspace TEXT NOT NULL,
    target_kind TEXT NOT NULL,
    target_ref TEXT NOT NULL,
    target_label TEXT NOT NULL,
    permissions TEXT NOT NULL,
    task_preview TEXT NOT NULL,
    run_id TEXT NULL,
    remote_conversation_id INTEGER NULL,
    remote_link TEXT NULL,
    remote_worktree TEXT NULL,
    status TEXT NOT NULL,
    blocked_on TEXT NULL,
    last_event_seq INTEGER NOT NULL DEFAULT 0,
    result_text TEXT NULL,
    result_subtype TEXT NULL,
    error_code TEXT NULL,
    error_message TEXT NULL,
    duration_ms INTEGER NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL,
    settled_at TIMESTAMP WITH TIME ZONE NULL,
    FOREIGN KEY (connection_id) REFERENCES remote_workspace_connection(id) ON DELETE SET NULL,
    FOREIGN KEY (parent_conversation_id) REFERENCES conversation(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_remote_delegation_task_id ON remote_delegation(task_id);
CREATE INDEX IF NOT EXISTS idx_remote_delegation_status ON remote_delegation(status);
CREATE INDEX IF NOT EXISTS idx_remote_delegation_parent ON remote_delegation(parent_conversation_id);
CREATE INDEX IF NOT EXISTS idx_remote_delegation_connection ON remote_delegation(connection_id);
CREATE TABLE IF NOT EXISTS remote_mention_grant (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    connection_id INTEGER NOT NULL,
    remote_folder_id INTEGER NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL,
    last_mentioned_at TIMESTAMP WITH TIME ZONE NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversation(id) ON DELETE CASCADE,
    FOREIGN KEY (connection_id) REFERENCES remote_workspace_connection(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_remote_mention_grant_unique ON remote_mention_grant(conversation_id, connection_id, remote_folder_id);
CREATE INDEX IF NOT EXISTS idx_remote_mention_grant_connection ON remote_mention_grant(connection_id);
"#).await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                r#"
DROP INDEX IF EXISTS idx_remote_mention_grant_connection;
DROP INDEX IF EXISTS idx_remote_mention_grant_unique;
DROP TABLE IF EXISTS remote_mention_grant;
DROP INDEX IF EXISTS idx_remote_delegation_connection;
DROP INDEX IF EXISTS idx_remote_delegation_parent;
DROP INDEX IF EXISTS idx_remote_delegation_status;
DROP INDEX IF EXISTS idx_remote_delegation_task_id;
DROP TABLE IF EXISTS remote_delegation;
"#,
            )
            .await?;
        Ok(())
    }
}
