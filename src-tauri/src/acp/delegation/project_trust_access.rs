//! 运行中的 MCP 调用只为调用者自身申请目录信任，不能选其他智能体或直接授权。
use super::listener::ParentSessionLookup;
use crate::{acp::manager::ConnectionManager, db::AppDatabase};
use serde_json::{json, Value};
use std::{path::PathBuf, sync::Arc};

pub struct ProjectTrustParentLookup {
    pub manager: Arc<ConnectionManager>,
    pub db: AppDatabase,
    pub data_dir: PathBuf,
}

#[async_trait::async_trait]
impl ParentSessionLookup for ProjectTrustParentLookup {
    async fn current_conversation_id(&self, connection_id: &str) -> Option<i32> {
        let state = self.manager.get_state(connection_id).await?;
        let id = state.read().await.conversation_id;
        id
    }

    async fn request_project_trust(&self, connection_id: &str, workspace: &str) -> Value {
        let Some((state, emitter)) = self.manager.get_state_and_emitter(connection_id).await else {
            return json!({"approved": false, "message": "调用者会话已结束"});
        };
        let (agent, session_id) = {
            let snapshot = state.read().await;
            (snapshot.agent_type, snapshot.external_id.clone())
        };
        if !matches!(
            agent,
            crate::models::agent::AgentType::Pi
                | crate::models::agent::AgentType::Gemini
                | crate::models::agent::AgentType::KimiCode
        ) {
            return json!({"approved": false, "message": "此智能体尚无目录信任适配器，请使用其原生权限确认机制；未写入任何授权"});
        }
        // 与当前会话相同的环境构造器，包含 session profile；不接受模型自选 profile。
        let result = async {
            let env = crate::commands::acp::build_session_runtime_env(
                &self.db,
                agent,
                session_id.as_deref(),
                &self.data_dir,
            )
            .await?;
            crate::acp::project_trust::broker()
                .before_launch(agent, &PathBuf::from(workspace), &env, &emitter)
                .await
        }
        .await;
        match result {
            Ok(()) => json!({
                "approved": true,
                "workspace": workspace,
                "message": "目录信任已确认。可继续原任务；这不提升文件系统权限，也不代表当前进程已重载扩展或 MCP。需要重载项目资源时使用智能体原生重载能力，不得擅自重启丢失任务。"
            }),
            Err(error) => {
                json!({"approved": false, "workspace": workspace, "message": error.to_string()})
            }
        }
    }
}
