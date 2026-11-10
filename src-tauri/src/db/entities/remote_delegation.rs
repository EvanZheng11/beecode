use sea_orm::entity::prelude::*;

/// 远程任务的本机持久化快照；远程标识不关联本机实体。
#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "remote_delegation")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    #[sea_orm(column_type = "Text", unique)]
    pub task_id: String,
    pub connection_id: Option<i32>,
    pub parent_conversation_id: i32,
    #[sea_orm(column_type = "Text")]
    pub parent_tool_use_id: String,
    #[sea_orm(column_type = "Text")]
    pub connection_name: String,
    pub remote_folder_id: i32,
    #[sea_orm(column_type = "Text")]
    pub remote_workspace: String,
    #[sea_orm(column_type = "Text")]
    pub target_kind: String,
    #[sea_orm(column_type = "Text")]
    pub target_ref: String,
    #[sea_orm(column_type = "Text")]
    pub target_label: String,
    #[sea_orm(column_type = "Text")]
    pub permissions: String,
    #[sea_orm(column_type = "Text")]
    pub task_preview: String,
    #[sea_orm(column_type = "Text", nullable)]
    pub run_id: Option<String>,
    pub remote_conversation_id: Option<i32>,
    #[sea_orm(column_type = "Text", nullable)]
    pub remote_link: Option<String>,
    #[sea_orm(column_type = "Text", nullable)]
    pub remote_worktree: Option<String>,
    #[sea_orm(column_type = "Text")]
    pub status: String,
    #[sea_orm(column_type = "Text", nullable)]
    pub blocked_on: Option<String>,
    pub last_event_seq: i64,
    #[sea_orm(column_type = "Text", nullable)]
    pub result_text: Option<String>,
    #[sea_orm(column_type = "Text", nullable)]
    pub result_subtype: Option<String>,
    #[sea_orm(column_type = "Text", nullable)]
    pub error_code: Option<String>,
    #[sea_orm(column_type = "Text", nullable)]
    pub error_message: Option<String>,
    pub duration_ms: Option<i64>,
    pub created_at: DateTimeUtc,
    pub updated_at: DateTimeUtc,
    pub settled_at: Option<DateTimeUtc>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "super::conversation::Entity",
        from = "Column::ParentConversationId",
        to = "super::conversation::Column::Id",
        on_delete = "Cascade"
    )]
    Conversation,
    #[sea_orm(
        belongs_to = "super::remote_workspace_connection::Entity",
        from = "Column::ConnectionId",
        to = "super::remote_workspace_connection::Column::Id",
        on_delete = "SetNull"
    )]
    Connection,
}

impl Related<super::conversation::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::Conversation.def()
    }
}
impl Related<super::remote_workspace_connection::Entity> for Entity {
    fn to() -> RelationDef {
        Relation::Connection.def()
    }
}
impl ActiveModelBehavior for ActiveModel {}
