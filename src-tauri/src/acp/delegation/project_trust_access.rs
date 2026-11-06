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
        // Kimi 等尚无持久化原生信任存储，不能把“未适配”误报为“已批准”。
        if !matches!(
            agent,
            crate::models::agent::AgentType::Pi | crate::models::agent::AgentType::Gemini
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
            let broker = crate::acp::project_trust::broker();
            let cwd = PathBuf::from(workspace);
            // 原生已拒绝或无需信任时如实返回，不能报告为“已批准”。
            match broker.native_refusal_or_unneeded(agent, &cwd, &env)? {
                Some(false) => return Ok(Some(false)),
                None => return Ok(None),
                Some(true) => {}
            }
            broker
                .before_launch(agent, &cwd, &env, &emitter)
                .await
                .map(|_| Some(true))
        }
        .await;
        match result {
            Ok(Some(false)) => json!({
                "approved": false,
                "workspace": workspace,
                "message": "该目录已被原生信任配置明确拒绝，未做任何更改；如需信任请由用户在设置中人工修改。"
            }),
            Ok(None) => json!({
                "approved": true,
                "workspace": workspace,
                "message": "该目录没有需要信任的项目资源，无需确认，可继续原任务。"
            }),
            Ok(Some(true)) => json!({
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
