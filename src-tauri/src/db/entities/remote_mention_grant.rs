use sea_orm::entity::prelude::*;

/// 授权只属于具体父会话，不沿 parent_id 继承。
#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "remote_mention_grant")]
pub struct Model {
    #[sea_orm(primary_key)]
    pub id: i32,
    pub conversation_id: i32,
    pub connection_id: i32,
    pub remote_folder_id: i32,
    pub created_at: DateTimeUtc,
    pub last_mentioned_at: DateTimeUtc,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {
    #[sea_orm(
        belongs_to = "super::conversation::Entity",
        from = "Column::ConversationId",
        to = "super::conversation::Column::Id",
        on_delete = "Cascade"
    )]
    Conversation,
    #[sea_orm(
        belongs_to = "super::remote_workspace_connection::Entity",
        from = "Column::ConnectionId",
        to = "super::remote_workspace_connection::Column::Id",
        on_delete = "Cascade"
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
