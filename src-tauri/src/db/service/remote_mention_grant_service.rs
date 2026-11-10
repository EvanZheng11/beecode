use chrono::Utc;
use sea_orm::sea_query::OnConflict;
use sea_orm::{
    ActiveValue::NotSet, ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter, QueryOrder, Set,
};

use crate::db::entities::remote_mention_grant::{self, Column, Entity, Model};
use crate::db::error::DbError;

/// 由发送边界在父会话绑定成功后调用；重复引用只更新最近时间。
pub async fn upsert(
    conn: &DatabaseConnection,
    conversation_id: i32,
    connection_id: i32,
    remote_folder_id: i32,
) -> Result<(), DbError> {
    if conversation_id <= 0 || connection_id <= 0 || remote_folder_id <= 0 {
        return Err(DbError::Validation("远程授权标识必须为正数".into()));
    }
    let now = Utc::now();
    Entity::insert(remote_mention_grant::ActiveModel {
        id: NotSet,
        conversation_id: Set(conversation_id),
        connection_id: Set(connection_id),
        remote_folder_id: Set(remote_folder_id),
        created_at: Set(now),
        last_mentioned_at: Set(now),
    })
    .on_conflict(
        OnConflict::columns([
            Column::ConversationId,
            Column::ConnectionId,
            Column::RemoteFolderId,
        ])
        .update_column(Column::LastMentionedAt)
        .to_owned(),
    )
    .exec(conn)
    .await?;
    Ok(())
}

/// 严格按父会话检查，不查询祖先，因此 fork 默认没有授权。
pub async fn is_granted(
    conn: &DatabaseConnection,
    conversation_id: i32,
    connection_id: i32,
    remote_folder_id: i32,
) -> Result<bool, DbError> {
    Ok(Entity::find()
        .filter(Column::ConversationId.eq(conversation_id))
        .filter(Column::ConnectionId.eq(connection_id))
        .filter(Column::RemoteFolderId.eq(remote_folder_id))
        .one(conn)
        .await?
        .is_some())
}

pub async fn list_by_conversation(
    conn: &DatabaseConnection,
    conversation_id: i32,
) -> Result<Vec<Model>, DbError> {
    Ok(Entity::find()
        .filter(Column::ConversationId.eq(conversation_id))
        .order_by_asc(Column::Id)
        .all(conn)
        .await?)
}
