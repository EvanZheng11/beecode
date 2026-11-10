//! 远程 broker 的持久化边界。查询返回实体 Model；变更返回是否命中可更新行。
//! 终态采用先到者胜出，迟到的 start、事件和取消不会复活或覆盖已结算任务。
use chrono::{DateTime, Duration, Utc};
use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter, QueryOrder, Set,
};

use crate::db::entities::remote_delegation::{self, Column, Entity, Model};
use crate::db::error::DbError;

pub const NON_TERMINAL_STATUSES: [&str; 4] = ["reserving", "running", "blocked", "unreachable"];
pub const TERMINAL_STATUSES: [&str; 3] = ["completed", "failed", "canceled"];
pub const MAX_RESULT_BYTES: usize = 256 * 1024;
pub const MAX_ERROR_BYTES: usize = 4 * 1024;
const TRUNCATED: &str = "\n[内容已截断]";

/// 创建时必需的不可变身份与展示快照。task_preview 按字符保留前 500 字。
#[derive(Clone, Debug)]
pub struct NewRemoteDelegation {
    pub task_id: String,
    pub connection_id: i32,
    pub parent_conversation_id: i32,
    pub parent_tool_use_id: String,
    pub connection_name: String,
    pub remote_folder_id: i32,
    pub remote_workspace: String,
    pub target_kind: String,
    pub target_ref: String,
    pub target_label: String,
    pub permissions: String,
    pub task_preview: String,
}

/// start 成功返回的远程信息，worktree 是 JSON 文本，不关联本机目录。
#[derive(Clone, Debug, Default)]
pub struct StartedRemoteDelegation {
    pub remote_conversation_id: Option<i32>,
    pub remote_link: Option<String>,
    pub remote_worktree: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub struct TerminalUpdate {
    pub result_text: Option<String>,
    pub result_subtype: Option<String>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub duration_ms: Option<i64>,
    pub last_event_seq: i64,
}

pub async fn create_reserving(
    conn: &DatabaseConnection,
    input: &NewRemoteDelegation,
) -> Result<Model, DbError> {
    if !["assistant", "agent"].contains(&input.target_kind.as_str())
        || !["wait", "deny", "reads", "allow", "fail"].contains(&input.permissions.as_str())
        || input.task_id.is_empty()
        || input.remote_folder_id <= 0
    {
        return Err(DbError::Validation("远程任务目标、权限或标识无效".into()));
    }
    let now = Utc::now();
    Ok(remote_delegation::ActiveModel {
        task_id: Set(input.task_id.clone()),
        connection_id: Set(Some(input.connection_id)),
        parent_conversation_id: Set(input.parent_conversation_id),
        parent_tool_use_id: Set(input.parent_tool_use_id.clone()),
        connection_name: Set(input.connection_name.clone()),
        remote_folder_id: Set(input.remote_folder_id),
        remote_workspace: Set(input.remote_workspace.clone()),
        target_kind: Set(input.target_kind.clone()),
        target_ref: Set(input.target_ref.clone()),
        target_label: Set(input.target_label.clone()),
        permissions: Set(input.permissions.clone()),
        task_preview: Set(input.task_preview.chars().take(500).collect()),
        status: Set("reserving".into()),
        last_event_seq: Set(0),
        created_at: Set(now),
        updated_at: Set(now),
        ..Default::default()
    }
    .insert(conn)
    .await?)
}

pub async fn get_by_task_id(
    conn: &DatabaseConnection,
    task_id: &str,
) -> Result<Option<Model>, DbError> {
    Ok(Entity::find()
        .filter(Column::TaskId.eq(task_id))
        .one(conn)
        .await?)
}

pub async fn list_by_parent_conversation(
    conn: &DatabaseConnection,
    parent_conversation_id: i32,
) -> Result<Vec<Model>, DbError> {
    Ok(Entity::find()
        .filter(Column::ParentConversationId.eq(parent_conversation_id))
        .order_by_asc(Column::Id)
        .all(conn)
        .await?)
}

/// 包括无 run_id 的 reserving 行，恢复执行器负责标记 interrupted_before_start。
pub async fn list_for_recovery(conn: &DatabaseConnection) -> Result<Vec<Model>, DbError> {
    Ok(Entity::find()
        .filter(Column::Status.is_in(NON_TERMINAL_STATUSES))
        .order_by_asc(Column::Id)
        .all(conn)
        .await?)
}

pub async fn list_unsettled_by_connection(
    conn: &DatabaseConnection,
    connection_id: i32,
) -> Result<Vec<Model>, DbError> {
    Ok(Entity::find()
        .filter(Column::ConnectionId.eq(connection_id))
        .filter(Column::Status.is_in(NON_TERMINAL_STATUSES))
        .order_by_asc(Column::Id)
        .all(conn)
        .await?)
}

/// reserve 后立即保存；仅 reserving 可更换 run_id（409 重新 reserve 的场景）。
pub async fn update_run_id(
    conn: &DatabaseConnection,
    task_id: &str,
    run_id: &str,
) -> Result<bool, DbError> {
    if run_id.is_empty() {
        return Err(DbError::Validation("run_id 不能为空".into()));
    }
    Ok(Entity::update_many()
        .set(remote_delegation::ActiveModel {
            run_id: Set(Some(run_id.into())),
            updated_at: Set(Utc::now()),
            ..Default::default()
        })
        .filter(Column::TaskId.eq(task_id))
        .filter(Column::Status.eq("reserving"))
        .exec(conn)
        .await?
        .rows_affected
        > 0)
}

pub async fn mark_started(
    conn: &DatabaseConnection,
    task_id: &str,
    started: &StartedRemoteDelegation,
) -> Result<bool, DbError> {
    Ok(Entity::update_many()
        .set(remote_delegation::ActiveModel {
            remote_conversation_id: Set(started.remote_conversation_id),
            remote_link: Set(started.remote_link.clone()),
            remote_worktree: Set(started.remote_worktree.clone()),
            status: Set("running".into()),
            blocked_on: Set(None),
            updated_at: Set(Utc::now()),
            ..Default::default()
        })
        .filter(Column::TaskId.eq(task_id))
        .filter(Column::Status.eq("reserving"))
        .filter(Column::RunId.is_not_null())
        .exec(conn)
        .await?
        .rows_affected
        > 0)
}

/// 状态及消费游标在同一条 UPDATE 落库；拒绝过期批次，游标不回退。
pub async fn update_progress(
    conn: &DatabaseConnection,
    task_id: &str,
    status: &str,
    blocked_on: Option<&str>,
    last_event_seq: i64,
) -> Result<bool, DbError> {
    validate_seq(last_event_seq)?;
    let valid_block = match status {
        "blocked" => matches!(blocked_on, Some("permission" | "question")),
        "running" | "unreachable" => blocked_on.is_none(),
        _ => false,
    };
    if !valid_block {
        return Err(DbError::Validation("远程任务进度状态或阻塞原因无效".into()));
    }
    Ok(Entity::update_many()
        .set(remote_delegation::ActiveModel {
            status: Set(status.into()),
            blocked_on: Set(blocked_on.map(str::to_owned)),
            last_event_seq: Set(last_event_seq),
            updated_at: Set(Utc::now()),
            ..Default::default()
        })
        .filter(Column::TaskId.eq(task_id))
        .filter(Column::Status.is_in(["running", "blocked", "unreachable"]))
        .filter(Column::LastEventSeq.lte(last_event_seq))
        .exec(conn)
        .await?
        .rows_affected
        > 0)
}

pub async fn update_event_cursor(
    conn: &DatabaseConnection,
    task_id: &str,
    last_event_seq: i64,
) -> Result<bool, DbError> {
    validate_seq(last_event_seq)?;
    Ok(Entity::update_many()
        .set(remote_delegation::ActiveModel {
            last_event_seq: Set(last_event_seq),
            updated_at: Set(Utc::now()),
            ..Default::default()
        })
        .filter(Column::TaskId.eq(task_id))
        .filter(Column::Status.is_in(NON_TERMINAL_STATUSES))
        .filter(Column::LastEventSeq.lt(last_event_seq))
        .exec(conn)
        .await?
        .rows_affected
        > 0)
}

/// 结果、错误、终态和结算时间原子写入；重复或迟到结算返回 false。
pub async fn settle(
    conn: &DatabaseConnection,
    task_id: &str,
    status: &str,
    terminal: &TerminalUpdate,
) -> Result<bool, DbError> {
    validate_seq(terminal.last_event_seq)?;
    if !TERMINAL_STATUSES.contains(&status) {
        return Err(DbError::Validation("不是远程任务终态".into()));
    }
    let now = Utc::now();
    Ok(Entity::update_many()
        .set(remote_delegation::ActiveModel {
            status: Set(status.into()),
            blocked_on: Set(None),
            result_text: Set(terminal
                .result_text
                .as_deref()
                .map(|s| truncate_utf8(s, MAX_RESULT_BYTES))),
            result_subtype: Set(terminal.result_subtype.clone()),
            error_code: Set(terminal.error_code.clone()),
            error_message: Set(terminal
                .error_message
                .as_deref()
                .map(|s| truncate_utf8(s, MAX_ERROR_BYTES))),
            duration_ms: Set(terminal.duration_ms),
            settled_at: Set(Some(now)),
            updated_at: Set(now),
            ..Default::default()
        })
        .col_expr(
            Column::LastEventSeq,
            Expr::cust_with_values("MAX(last_event_seq, ?)", [terminal.last_event_seq]),
        )
        .filter(Column::TaskId.eq(task_id))
        .filter(Column::Status.is_in(NON_TERMINAL_STATUSES))
        .exec(conn)
        .await?
        .rows_affected
        > 0)
}

/// 仅清理终态且结束超过 90 天的记录，单次最多 1000 行；调用方负责启动调度。
pub async fn cleanup_settled(
    conn: &DatabaseConnection,
    now: DateTime<Utc>,
) -> Result<u64, DbError> {
    use sea_orm::{ConnectionTrait, DbBackend, Statement};
    let result = conn.execute(Statement::from_sql_and_values(DbBackend::Sqlite,
        "DELETE FROM remote_delegation WHERE id IN (SELECT id FROM remote_delegation WHERE status IN ('completed', 'failed', 'canceled') AND settled_at < ? ORDER BY settled_at, id LIMIT 1000)",
        [(now - Duration::days(90)).into()])).await?;
    Ok(result.rows_affected())
}

#[cfg(test)]
mod tests;

fn validate_seq(seq: i64) -> Result<(), DbError> {
    if seq < 0 {
        return Err(DbError::Validation("事件游标不能为负数".into()));
    }
    Ok(())
}

fn truncate_utf8(text: &str, max_bytes: usize) -> String {
    if text.len() <= max_bytes {
        return text.into();
    }
    let mut end = max_bytes - TRUNCATED.len();
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}{TRUNCATED}", &text[..end])
}
