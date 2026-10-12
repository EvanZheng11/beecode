//! Ask-user-question settings persistence — the web/Tauri-shared surface for
//! the `ask_user_question` feature toggle.
//!
//! Four keys survive across restarts (`question.wait_timeout_minutes`,
//! `question.retry_count` and `question.auto_select_first_on_timeout` are the
//! MCP wait policy — how long one ask waits, how often it re-asks, and whether
//! an exhausted ask falls back to the first option):
//!   * `question.enabled` — feature kill switch (**default true**). When on,
//!     `codeg-mcp` exposes the `ask_user_question` tool so an agent can block on
//!     a multiple-choice question rendered above the conversation input box.
//!
//! Default-ON deliberately diverges from live-feedback / delegation (both
//! default OFF). Those add a tool the agent polls / fans out unprompted, so they
//! are opt-in; `ask_user_question` only surfaces when the agent *explicitly*
//! pauses on a decision that is genuinely the user's, so it is far less
//! intrusive and ships enabled. A user who never wants the agent to ask can turn
//! it off in settings.
//!
//! On startup `apply_persisted_question_config` reads this key from
//! `app_metadata` and pushes it into the shared [`QuestionRuntimeConfig`] that
//! MCP injection reads. On UI save, `set_question_settings_core` writes the key
//! and immediately re-applies — mirroring the feedback settings flow exactly
//! (`crate::commands::feedback`).

use sea_orm::{ConnectionTrait, DatabaseConnection, TransactionError, TransactionTrait};
use serde::{Deserialize, Serialize};

use crate::acp::question::{
    QuestionConfig, QuestionRuntimeConfig, DEFAULT_QUESTION_RETRY_COUNT,
    DEFAULT_QUESTION_TIMEOUT_MINUTES, MAX_QUESTION_RETRY_COUNT, MAX_QUESTION_TIMEOUT_MINUTES,
};
use crate::app_error::{AppCommandError, AppErrorCode};
use crate::db::service::app_metadata_service;
use crate::web::event_bridge::{emit_event, EventEmitter, QUESTION_SETTINGS_CHANGED_EVENT};

pub const KEY_QUESTION_ENABLED: &str = "question.enabled";
/// MCP 提问等待时长（分钟）。
pub const KEY_QUESTION_WAIT_TIMEOUT_MINUTES: &str = "question.wait_timeout_minutes";
/// 等待超时后重新提问的次数。
pub const KEY_QUESTION_RETRY_COUNT: &str = "question.retry_count";
/// 等待全部用尽后是否自动选择每个问题的第一个选项。
pub const KEY_QUESTION_AUTO_SELECT_FIRST_ON_TIMEOUT: &str =
    "question.auto_select_first_on_timeout";

/// On by default (`enabled: true`) — see the module docs for why this diverges
/// from the opt-in feedback/delegation features. 另外三个字段是 MCP 等待策略，
/// 默认值见 [`QuestionSettings::default`]。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct QuestionSettings {
    pub enabled: bool,
    /// 单次询问等待用户回答的时长（分钟）。
    pub wait_timeout_minutes: u32,
    /// 等待超时后重新询问的次数，0 表示不重提。
    pub retry_count: u32,
    /// 等待全部用尽后自动选择每个问题的第一个选项，而不是继续等待。
    pub auto_select_first_on_timeout: bool,
}

impl Default for QuestionSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            wait_timeout_minutes: DEFAULT_QUESTION_TIMEOUT_MINUTES,
            retry_count: DEFAULT_QUESTION_RETRY_COUNT,
            auto_select_first_on_timeout: true,
        }
    }
}

impl QuestionSettings {
    /// 收敛到合法区间：等待时长至少 1 分钟、最多 [`MAX_QUESTION_TIMEOUT_MINUTES`]，
    /// 重提次数最多 [`MAX_QUESTION_RETRY_COUNT`]。保存和读取走同一套边界，
    /// 手改数据库写进的越界值也不会传到运行时。
    fn normalized(mut self) -> Self {
        self.wait_timeout_minutes = self
            .wait_timeout_minutes
            .clamp(1, MAX_QUESTION_TIMEOUT_MINUTES);
        self.retry_count = self.retry_count.min(MAX_QUESTION_RETRY_COUNT);
        self
    }

    fn into_runtime_config(self) -> QuestionConfig {
        QuestionConfig {
            enabled: self.enabled,
            wait_timeout_minutes: self.wait_timeout_minutes,
            retry_count: self.retry_count,
            auto_select_first_on_timeout: self.auto_select_first_on_timeout,
        }
    }
}

/// 只更新 MCP 等待策略的字段集合。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct QuestionPolicy {
    pub wait_timeout_minutes: u32,
    pub retry_count: u32,
    pub auto_select_first_on_timeout: bool,
}

/// 从 `app_metadata` 读取一条提问配置。缺失或格式错误的单个字段回退默认值，
/// 数据库读取错误向字段级写入路径返回，避免把默认值误当成当前记录覆盖其他字段。
async fn load_question_settings_conn<C: ConnectionTrait>(
    conn: &C,
) -> Result<QuestionSettings, AppCommandError> {
    let mut settings = QuestionSettings::default();
    if let Some(raw) = app_metadata_service::get_value_conn(conn, KEY_QUESTION_ENABLED)
        .await
        .map_err(AppCommandError::from)?
    {
        if let Ok(v) = raw.parse::<bool>() {
            settings.enabled = v;
        }
    }
    if let Some(raw) = app_metadata_service::get_value_conn(conn, KEY_QUESTION_WAIT_TIMEOUT_MINUTES)
        .await
        .map_err(AppCommandError::from)?
    {
        if let Ok(v) = raw.parse::<u32>() {
            settings.wait_timeout_minutes = v;
        }
    }
    if let Some(raw) = app_metadata_service::get_value_conn(conn, KEY_QUESTION_RETRY_COUNT)
        .await
        .map_err(AppCommandError::from)?
    {
        if let Ok(v) = raw.parse::<u32>() {
            settings.retry_count = v;
        }
    }
    if let Some(raw) =
        app_metadata_service::get_value_conn(conn, KEY_QUESTION_AUTO_SELECT_FIRST_ON_TIMEOUT)
            .await
            .map_err(AppCommandError::from)?
    {
        if let Ok(v) = raw.parse::<bool>() {
            settings.auto_select_first_on_timeout = v;
        }
    }
    Ok(settings.normalized())
}

/// 从 `app_metadata` 读取配置；缺失或格式错误的字段回退默认值。
/// 普通读取保留兼容的尽力行为，字段级写入使用上面的可失败读取路径。
pub async fn load_question_settings(conn: &DatabaseConnection) -> QuestionSettings {
    match load_question_settings_conn(conn).await {
        Ok(settings) => settings,
        Err(error) => {
            tracing::warn!(error = %error, "读取提问配置失败，使用默认值");
            QuestionSettings::default()
        }
    }
}

/// Pull settings from the DB and push the resulting `QuestionConfig` onto the
/// shared runtime handle. Idempotent — safe on startup, after settings save, or
/// after any external write to `app_metadata`.
pub async fn apply_persisted_question_config(
    conn: &DatabaseConnection,
    config: &QuestionRuntimeConfig,
) {
    let settings = load_question_settings(conn).await;
    config.set(settings.into_runtime_config()).await;
}

enum QuestionSettingsUpdate {
    Full(QuestionSettings),
    Enabled(bool),
    Policy(QuestionPolicy),
}

/// 同一进程内的提问配置写入必须按顺序执行；锁覆盖读取、合并、事务和广播前的
/// 规范化，避免两个设置窗口各自拿旧快照写回。
static QUESTION_SETTINGS_WRITE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

async fn write_question_settings<C: ConnectionTrait>(
    conn: &C,
    desired: &QuestionSettings,
) -> Result<(), AppCommandError> {
    app_metadata_service::upsert_value(conn, KEY_QUESTION_ENABLED, &desired.enabled.to_string())
        .await
        .map_err(AppCommandError::from)?;
    app_metadata_service::upsert_value(
        conn,
        KEY_QUESTION_WAIT_TIMEOUT_MINUTES,
        &desired.wait_timeout_minutes.to_string(),
    )
    .await
    .map_err(AppCommandError::from)?;
    app_metadata_service::upsert_value(
        conn,
        KEY_QUESTION_RETRY_COUNT,
        &desired.retry_count.to_string(),
    )
    .await
    .map_err(AppCommandError::from)?;
    app_metadata_service::upsert_value(
        conn,
        KEY_QUESTION_AUTO_SELECT_FIRST_ON_TIMEOUT,
        &desired.auto_select_first_on_timeout.to_string(),
    )
    .await
    .map_err(AppCommandError::from)?;
    Ok(())
}

async fn update_question_settings_core(
    conn: &DatabaseConnection,
    config: &QuestionRuntimeConfig,
    emitter: &EventEmitter,
    update: QuestionSettingsUpdate,
) -> Result<QuestionSettings, AppCommandError> {
    let _write_guard = QUESTION_SETTINGS_WRITE_LOCK.lock().await;
    let desired = conn
        .transaction::<_, QuestionSettings, AppCommandError>(move |txn| {
            Box::pin(async move {
                let mut desired = load_question_settings_conn(txn).await?;
                match update {
                    QuestionSettingsUpdate::Full(settings) => desired = settings,
                    QuestionSettingsUpdate::Enabled(enabled) => desired.enabled = enabled,
                    QuestionSettingsUpdate::Policy(policy) => {
                        desired.wait_timeout_minutes = policy.wait_timeout_minutes;
                        desired.retry_count = policy.retry_count;
                        desired.auto_select_first_on_timeout =
                            policy.auto_select_first_on_timeout;
                    }
                }
                desired = desired.normalized();
                write_question_settings(txn, &desired).await?;
                Ok(desired)
            })
        })
        .await
        .map_err(|error: TransactionError<AppCommandError>| match error {
            TransactionError::Connection(error) => AppCommandError::new(
                AppErrorCode::DatabaseError,
                "Database transaction failed",
            )
            .with_detail(error.to_string()),
            TransactionError::Transaction(error) => error,
        })?;

    tracing::debug!(
        enabled = desired.enabled,
        wait_timeout_minutes = desired.wait_timeout_minutes,
        retry_count = desired.retry_count,
        auto_select_first_on_timeout = desired.auto_select_first_on_timeout,
        "提问配置已保存并同步到运行时"
    );
    config.set(desired.clone().into_runtime_config()).await;
    emit_event(emitter, QUESTION_SETTINGS_CHANGED_EVENT, &desired);
    Ok(desired)
}

/// 持久化、应用并广播完整的规范化记录。现有调用方继续使用整条配置接口，
/// 新的设置编辑器使用下面的字段级接口。
pub async fn set_question_settings_core(
    conn: &DatabaseConnection,
    config: &QuestionRuntimeConfig,
    emitter: &EventEmitter,
    desired: QuestionSettings,
) -> Result<QuestionSettings, AppCommandError> {
    update_question_settings_core(
        conn,
        config,
        emitter,
        QuestionSettingsUpdate::Full(desired),
    )
    .await
}

/// 只更新提问开关，并返回合并后的完整规范化记录。
pub async fn update_question_enabled_core(
    conn: &DatabaseConnection,
    config: &QuestionRuntimeConfig,
    emitter: &EventEmitter,
    enabled: bool,
) -> Result<QuestionSettings, AppCommandError> {
    update_question_settings_core(
        conn,
        config,
        emitter,
        QuestionSettingsUpdate::Enabled(enabled),
    )
    .await
}

/// 只更新三项 MCP 等待策略，并返回合并后的完整规范化记录。
pub async fn update_question_policy_core(
    conn: &DatabaseConnection,
    config: &QuestionRuntimeConfig,
    emitter: &EventEmitter,
    policy: QuestionPolicy,
) -> Result<QuestionSettings, AppCommandError> {
    update_question_settings_core(
        conn,
        config,
        emitter,
        QuestionSettingsUpdate::Policy(policy),
    )
    .await
}

// -------- Tauri commands -----------------------------------------------------

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn get_question_settings(
    #[cfg(feature = "tauri-runtime")] db: tauri::State<'_, crate::db::AppDatabase>,
) -> Result<QuestionSettings, AppCommandError> {
    #[cfg(feature = "tauri-runtime")]
    {
        Ok(load_question_settings(&db.conn).await)
    }
    #[cfg(not(feature = "tauri-runtime"))]
    {
        Err(AppCommandError::configuration_invalid("tauri-only command"))
    }
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn set_question_settings(
    #[cfg(feature = "tauri-runtime")] app: tauri::AppHandle,
    #[cfg(feature = "tauri-runtime")] db: tauri::State<'_, crate::db::AppDatabase>,
    #[cfg(feature = "tauri-runtime")] config: tauri::State<'_, QuestionRuntimeConfig>,
    settings: QuestionSettings,
) -> Result<QuestionSettings, AppCommandError> {
    #[cfg(feature = "tauri-runtime")]
    {
        let emitter = EventEmitter::Tauri(app);
        set_question_settings_core(&db.conn, &config, &emitter, settings).await
    }
    #[cfg(not(feature = "tauri-runtime"))]
    {
        let _ = settings;
        Err(AppCommandError::configuration_invalid("tauri-only command"))
    }
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn update_question_enabled(
    #[cfg(feature = "tauri-runtime")] app: tauri::AppHandle,
    #[cfg(feature = "tauri-runtime")] db: tauri::State<'_, crate::db::AppDatabase>,
    #[cfg(feature = "tauri-runtime")] config: tauri::State<'_, QuestionRuntimeConfig>,
    enabled: bool,
) -> Result<QuestionSettings, AppCommandError> {
    #[cfg(feature = "tauri-runtime")]
    {
        let emitter = EventEmitter::Tauri(app);
        update_question_enabled_core(&db.conn, &config, &emitter, enabled).await
    }
    #[cfg(not(feature = "tauri-runtime"))]
    {
        let _ = enabled;
        Err(AppCommandError::configuration_invalid("tauri-only command"))
    }
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn update_question_policy(
    #[cfg(feature = "tauri-runtime")] app: tauri::AppHandle,
    #[cfg(feature = "tauri-runtime")] db: tauri::State<'_, crate::db::AppDatabase>,
    #[cfg(feature = "tauri-runtime")] config: tauri::State<'_, QuestionRuntimeConfig>,
    policy: QuestionPolicy,
) -> Result<QuestionSettings, AppCommandError> {
    #[cfg(feature = "tauri-runtime")]
    {
        let emitter = EventEmitter::Tauri(app);
        update_question_policy_core(&db.conn, &config, &emitter, policy).await
    }
    #[cfg(not(feature = "tauri-runtime"))]
    {
        let _ = policy;
        Err(AppCommandError::configuration_invalid("tauri-only command"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn load_returns_default_enabled_when_unset() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let settings = load_question_settings(&db.conn).await;
        assert!(settings.enabled, "ask_user_question defaults ON");
    }

    #[tokio::test]
    async fn set_then_load_round_trip_and_runtime_applied() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let config = QuestionRuntimeConfig::new();
        let saved = set_question_settings_core(
            &db.conn,
            &config,
            &EventEmitter::Noop,
            QuestionSettings {
                enabled: false,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        assert!(!saved.enabled);

        let loaded = load_question_settings(&db.conn).await;
        assert!(!loaded.enabled);
        assert!(!config.is_enabled().await);
    }

    #[tokio::test]
    async fn apply_persisted_pushes_db_value_onto_runtime() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        app_metadata_service::upsert_value(&db.conn, KEY_QUESTION_ENABLED, "false")
            .await
            .unwrap();
        let config = QuestionRuntimeConfig::new();
        // Default runtime is disabled; applying the persisted "false" keeps it off.
        apply_persisted_question_config(&db.conn, &config).await;
        assert!(!config.is_enabled().await);
    }

    /// 未写入任何配置时，MCP 等待策略应取默认值（10 分钟 / 3 次 / 超时自动选首项）。
    #[tokio::test]
    async fn defaults_include_mcp_timeout_policy() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let settings = load_question_settings(&db.conn).await;
        assert_eq!(settings.wait_timeout_minutes, 10);
        assert_eq!(settings.retry_count, 3);
        assert!(settings.auto_select_first_on_timeout);
    }

    /// 保存时非法值先被规范化，落库与运行时快照都拿到规范化后的值。
    #[tokio::test]
    async fn set_normalizes_timeout_policy_and_updates_runtime() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let config = QuestionRuntimeConfig::new();
        let saved = set_question_settings_core(
            &db.conn,
            &config,
            &EventEmitter::Noop,
            QuestionSettings {
                enabled: true,
                wait_timeout_minutes: 0,
                retry_count: 99,
                auto_select_first_on_timeout: false,
            },
        )
        .await
        .unwrap();
        assert_eq!(saved.wait_timeout_minutes, 1);
        assert_eq!(saved.retry_count, 10);
        assert!(!config.snapshot().await.auto_select_first_on_timeout);
    }

    /// 两个字段级写入交错执行时，最终记录必须同时保留双方更新。
    #[tokio::test]
    async fn field_updates_merge_without_losing_each_other() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let config = QuestionRuntimeConfig::new();
        set_question_settings_core(
            &db.conn,
            &config,
            &EventEmitter::Noop,
            QuestionSettings::default(),
        )
        .await
        .unwrap();

        let (enabled, policy) = tokio::join!(
            update_question_enabled_core(&db.conn, &config, &EventEmitter::Noop, false),
            update_question_policy_core(
                &db.conn,
                &config,
                &EventEmitter::Noop,
                QuestionPolicy {
                    wait_timeout_minutes: 45,
                    retry_count: 7,
                    auto_select_first_on_timeout: false,
                },
            ),
        );
        assert!(!enabled.unwrap().enabled);
        assert_eq!(policy.unwrap().wait_timeout_minutes, 45);

        let saved = load_question_settings(&db.conn).await;
        assert!(!saved.enabled);
        assert_eq!(saved.wait_timeout_minutes, 45);
        assert_eq!(saved.retry_count, 7);
        assert!(!saved.auto_select_first_on_timeout);
    }

    /// 保存后重新读取得到同一组值；已落库的值损坏时按字段回退默认值。
    #[tokio::test]
    async fn timeout_policy_round_trips_and_corrupt_value_falls_back() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let config = QuestionRuntimeConfig::new();
        set_question_settings_core(
            &db.conn,
            &config,
            &EventEmitter::Noop,
            QuestionSettings {
                enabled: true,
                wait_timeout_minutes: 45,
                retry_count: 4,
                auto_select_first_on_timeout: false,
            },
        )
        .await
        .unwrap();

        let loaded = load_question_settings(&db.conn).await;
        assert_eq!(loaded.wait_timeout_minutes, 45);
        assert_eq!(loaded.retry_count, 4);
        assert!(!loaded.auto_select_first_on_timeout);

        app_metadata_service::upsert_value(&db.conn, KEY_QUESTION_RETRY_COUNT, "not-a-number")
            .await
            .unwrap();
        let fallback = load_question_settings(&db.conn).await;
        assert_eq!(fallback.retry_count, DEFAULT_QUESTION_RETRY_COUNT);
        assert_eq!(
            config.snapshot().await.retry_count,
            4,
            "重新加载不改变运行时句柄，只有 set 才会写入"
        );
    }
}
