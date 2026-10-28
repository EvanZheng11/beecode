//! The OpenCode codeg launches: OpenCode 2, and nothing older.
//!
//! codeg pins OpenCode 2 (`AgentType::OpenCode` in `registry.rs`) and writes
//! everything it configures in OpenCode 2's own terms: the `providers`,
//! `permissions`, `update` and `plugins` keys, and credentials in the
//! `credential` table of `opencode.db` instead of `auth.json`. OpenCode 1.x
//! reads none of that, so a 1.x session would run without the providers,
//! permissions and MCP servers the settings page shows as applied. It would
//! also run on a database OpenCode 2 may already have migrated (a 1.x build in
//! a repository whose cached project id changed exits before `initialize` with
//! `no such column: project_id`).
//!
//! Rather than half-work, a 1.x runtime is refused before it starts, with a
//! message naming the version found and where to upgrade. The error is
//! [`AcpError::AgentRuntimeOutdated`](crate::acp::error::AcpError), which the
//! frontend shows with an "Open Agent Settings" action.
//!
//! The launch argv is the bare `opencode acp` the registry declares. OpenCode 2's
//! `acp` takes no `--port`/`--hostname` (the CLI rejects both and prints its
//! usage to stdout, the ACP channel): it starts its own private server on an
//! automatic loopback port and reads no `server.*` config, so the 1.x
//! `ServeError` codeg once passed explicit listen flags for (codeg#860) cannot
//! happen.

use std::path::Path;

use crate::models::agent::AgentType;

/// The oldest OpenCode major codeg launches.
const MIN_SUPPORTED_MAJOR: u64 = 2;

/// 约 24.85 天：覆盖最长 11 天的配置重提，且不超过 JS 计时器的有符号整数上限。
/// 关闭自动选择后的等待仍受宿主期限约束，不能承诺无限等待。
pub(crate) const CODEG_MCP_TIMEOUT_MS: u32 = i32::MAX as u32;

/// ACP mcpConfig 不转发 timeout；OpenCode 的 MCP.tools 会回查同名静态配置。
/// 仅在启动环境覆盖自有服务器，禁用静态启动，由 ACP 注入实际命令和令牌。
pub(crate) fn with_codeg_mcp_timeout(raw: &str) -> Result<String, String> {
    let (protected, replacements) = protect_config_templates(raw)?;
    let mut config = crate::acp::opencode_config::parse(&protected)
        .map_err(|_| "OpenCode 启动配置不是有效的 JSONC")?;
    // Unicode 转义解码后的键也可能撞上占位符；全局还原前拒绝，避免改写用户键。
    let mut pending = vec![&config];
    while let Some(value) = pending.pop() {
        match value {
            serde_json::Value::Object(object) => {
                if object
                    .keys()
                    .any(|key| replacements.iter().any(|(marker, _)| marker == key))
                {
                    return Err(
                        "OpenCode 启动配置对象键与占位符冲突，保留原配置并跳过期限注入".into(),
                    );
                }
                pending.extend(object.values());
            }
            serde_json::Value::Array(array) => pending.extend(array),
            _ => {}
        }
    }
    let root = config
        .as_object_mut()
        .ok_or("OpenCode 启动配置必须是对象")?;
    let mcp = root.entry("mcp").or_insert_with(|| serde_json::json!({}));
    let mcp = mcp.as_object_mut().ok_or("OpenCode MCP 配置必须是对象")?;
    let servers = mcp
        .entry("servers")
        .or_insert_with(|| serde_json::json!({}));
    // 字符串已保护为占位符；原生服务器表的值必须是对象，字符串 type 属于旧版条目。
    if servers
        .get("type")
        .is_some_and(serde_json::Value::is_string)
    {
        return Err("OpenCode mcp.servers 是旧版服务器条目，跳过期限注入".into());
    }
    let servers = servers
        .as_object_mut()
        .ok_or("OpenCode mcp.servers 配置必须是对象")?;
    servers.insert(
        "codeg-mcp".into(),
        serde_json::json!({
            "type": "local",
            "command": ["codeg-mcp"],
            "disabled": true,
            "timeout": CODEG_MCP_TIMEOUT_MS,
        }),
    );
    let mut merged =
        serde_json::to_string(&config).map_err(|_| "序列化 OpenCode 启动配置失败".to_string())?;
    for (marker, original) in replacements {
        merged = merged.replace(&format!("\"{marker}\""), &original);
    }
    Ok(merged)
}

/// 只保护词法内容，不读取环境变量或文件；宿主仍负责替换和解析模板。
/// 字符串整体保留原始转义，注释中的引号和模板不参与扫描。
fn protect_config_templates(raw: &str) -> Result<(String, Vec<(String, String)>), String> {
    let mut prefix = "__codeg_config_literal_".to_string();
    while raw.contains(&prefix) {
        prefix.push('_');
    }
    let bytes = raw.as_bytes();
    let mut protected = String::with_capacity(raw.len());
    let mut replacements = Vec::new();
    let (mut i, mut copied) = (0, 0);
    while i < bytes.len() {
        i = skip_config_trivia(bytes, i);
        if i >= bytes.len() {
            break;
        }
        let start = i;
        if bytes[i] == b'"' {
            i += 1;
            while i < bytes.len() {
                match bytes[i] {
                    b'\\' => i += 2,
                    b'"' => break,
                    _ => i += 1,
                }
            }
            if i >= bytes.len() {
                return Err("OpenCode 启动配置字符串未闭合，跳过期限注入".into());
            }
            i += 1;
            let value: String = serde_json::from_str(&raw[start..i])
                .map_err(|_| "OpenCode 启动配置字符串无法安全解析".to_string())?;
            // 对象键保留解析语义（包括重复键）；动态键无法确定是否覆盖自有配置。
            if bytes.get(skip_config_trivia(bytes, i)) == Some(&b':') {
                if value.contains("{env:") || value.contains("{file:") {
                    return Err("OpenCode 启动配置含动态键，保留原配置并跳过期限注入".into());
                }
                continue;
            }
        } else if bytes[i..].starts_with(b"{env:") || bytes[i..].starts_with(b"{file:") {
            let end = raw[i..]
                .find('}')
                .ok_or("OpenCode 启动配置模板未闭合，跳过期限注入")?;
            i += end + 1;
        } else {
            i += 1;
            continue;
        }
        let marker = format!("{prefix}{}__", replacements.len());
        protected.push_str(&raw[copied..start]);
        protected.push('"');
        protected.push_str(&marker);
        protected.push('"');
        replacements.push((marker, raw[start..i].to_string()));
        copied = i;
    }
    protected.push_str(&raw[copied..]);
    Ok((protected, replacements))
}

fn skip_config_trivia(bytes: &[u8], mut i: usize) -> usize {
    loop {
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if bytes[i..].starts_with(b"//") {
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
        } else if bytes[i..].starts_with(b"/*") {
            i += 2;
            while i + 1 < bytes.len() && !bytes[i..].starts_with(b"*/") {
                i += 1;
            }
            i = (i + 2).min(bytes.len());
        } else {
            return i;
        }
    }
}

/// Whether `version` names an OpenCode release older than 2.0.
///
/// Only a release can be judged. opencode publishes every preview channel
/// (`dev`, `beta`, `next`, per-branch snapshots) as `0.0.0-<tag>` whatever the
/// build's age, and a source build or an unreadable `--version` has no usable
/// version at all; those launch, because refusing a build that may well be 2.x
/// would be worse than letting an old one show its own errors.
fn is_pre_v2_release(version: &str) -> bool {
    let Ok(version) = semver::Version::parse(version.trim()) else {
        return false;
    };
    if (version.major, version.minor, version.patch) == (0, 0, 0) {
        return false;
    }
    version.major < MIN_SUPPORTED_MAJOR
}

/// The version of the OpenCode about to be launched from `bin` when it is a
/// 1.x (or older) release, `None` when it may launch.
///
/// `cached_version` is the codeg-managed install's version label: the release
/// tag its archive was downloaded from. A binary found on PATH comes without
/// one, so its `--version` is read through the probe the agent list already
/// runs on it (cached per path and mtime), which usually makes this free.
pub(crate) async fn pre_v2_runtime(bin: &Path, cached_version: Option<&str>) -> Option<String> {
    let version = match cached_version {
        Some(version) => version.trim().to_string(),
        None => crate::commands::acp::system_probed_version(AgentType::OpenCode, bin, None).await?,
    };
    is_pre_v2_release(&version).then_some(version)
}

/// What [`AcpError::AgentRuntimeOutdated`](crate::acp::error::AcpError)
/// carries for a refused 1.x OpenCode: which build was found, and the way out
/// for that kind of install. A managed install upgrades from the agent's
/// settings; a binary from PATH is the user's own, so the message offers both
/// codeg's managed copy (which takes precedence once installed) and upgrading
/// their install.
pub(crate) fn runtime_outdated_message(
    version: &str,
    bin: &Path,
    managed: bool,
    pinned: &str,
) -> String {
    if managed {
        format!(
            "OpenCode {version} is no longer supported: this version of Codeg runs OpenCode 2. \
             Upgrade it to {pinned} in Agent Settings → OpenCode."
        )
    } else {
        format!(
            "The OpenCode found on PATH ({}) is version {version}, which this version of Codeg \
             no longer supports: it runs OpenCode 2. Install OpenCode {pinned} in Agent Settings → \
             OpenCode, or upgrade your own install to OpenCode 2 (`opencode upgrade --major`).",
            bin.display()
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::registry::{self, AgentDistribution};
    #[cfg(unix)]
    use std::path::PathBuf;

    #[test]
    fn codeg_mcp_timeout_covers_all_configured_retries_without_changing_other_servers() {
        let raw = r#"{
            // 用户启动环境中的其它配置必须保留。
            "model": "provider/model",
            "experimental": { "mcp_timeout": 1234 },
            "mcp": { "other": { "type": "local", "command": ["other"], "timeout": 5000 } },
        }"#;
        let merged: serde_json::Value =
            serde_json::from_str(&with_codeg_mcp_timeout(raw).unwrap()).unwrap();
        assert_eq!(merged["model"], "provider/model");
        assert_eq!(merged["experimental"]["mcp_timeout"], 1234);
        assert_eq!(merged["mcp"]["other"]["timeout"], 5000);
        assert_eq!(merged["mcp"]["servers"]["codeg-mcp"]["disabled"], true);
        assert_eq!(
            merged["mcp"]["servers"]["codeg-mcp"]["timeout"],
            CODEG_MCP_TIMEOUT_MS
        );
        let max_wait_ms = u64::from(crate::acp::question::MAX_QUESTION_TIMEOUT_MINUTES)
            * 60_000
            * u64::from(crate::acp::question::MAX_QUESTION_RETRY_COUNT + 1);
        let timeout = merged["mcp"]["servers"]["codeg-mcp"]["timeout"]
            .as_u64()
            .unwrap();
        assert!(timeout > max_wait_ms);
        assert!(timeout <= i32::MAX as u64);
        assert!(with_codeg_mcp_timeout("{}").is_ok());
        assert!(with_codeg_mcp_timeout("invalid").is_err());
        assert!(with_codeg_mcp_timeout("[]").is_err());
        assert!(with_codeg_mcp_timeout(r#"{"mcp": []}"#).is_err());
    }

    #[test]
    fn codeg_mcp_timeout_overrides_native_entry_and_preserves_other_settings() {
        let raw = r#"{"mcp":{"timeout":5000,"servers":{
            "codeg-mcp":{"type":"local","command":["old"],"timeout":1},
            "other":{"type":"remote","url":"https://example.test","timeout":1234}
        }}}"#;
        let original = crate::acp::opencode_config::parse(raw).unwrap();
        let merged =
            crate::acp::opencode_config::parse(&with_codeg_mcp_timeout(raw).unwrap()).unwrap();
        assert_eq!(
            merged["mcp"]["servers"]["codeg-mcp"]["timeout"],
            CODEG_MCP_TIMEOUT_MS
        );
        assert_eq!(merged["mcp"]["servers"]["codeg-mcp"]["disabled"], true);
        assert_eq!(
            merged["mcp"]["servers"]["other"],
            original["mcp"]["servers"]["other"]
        );
        assert_eq!(merged["mcp"]["timeout"], 5000);
        assert!(with_codeg_mcp_timeout(r#"{"mcp":{"servers":[]}}"#).is_err());
        assert!(with_codeg_mcp_timeout(
            r#"{"mcp":{"servers":{"type":"local","command":["other"]}}}"#
        )
        .is_err());
    }

    #[test]
    fn codeg_mcp_timeout_preserves_host_templates_without_expanding_them() {
        let raw = r#"{
            // 注释中的 " 和 {env:IGNORED} 不参与词法替换。
            "experimental": {"mcp_timeout": {env:QUESTION_MCP_TIMEOUT}},
            "instructions": [{file:./instructions.json}],
            "provider": {"token": "{env:PRIVATE_TOKEN}", "prompt": "{file:./prompt.txt}"},
            "mcp": {"other": {"type": "local", "command": ["other"], "timeout": {env:OTHER_TIMEOUT}}}
        }"#;
        let merged = with_codeg_mcp_timeout(raw).unwrap();
        for template in [
            "{env:QUESTION_MCP_TIMEOUT}",
            "{file:./instructions.json}",
            "\"{env:PRIVATE_TOKEN}\"",
            "\"{file:./prompt.txt}\"",
            "{env:OTHER_TIMEOUT}",
        ] {
            assert!(merged.contains(template));
        }
        // 仅用测试常量模拟宿主后续替换，不读取用户环境和文件。
        let resolved = merged
            .replace("{env:QUESTION_MCP_TIMEOUT}", "600000")
            .replace("{file:./instructions.json}", "[\"测试指令\"]")
            .replace("{env:OTHER_TIMEOUT}", "5000");
        let parsed: serde_json::Value = serde_json::from_str(&resolved).unwrap();
        assert_eq!(parsed["experimental"]["mcp_timeout"], 600000);
        assert_eq!(parsed["mcp"]["other"]["command"][0], "other");
        assert_eq!(parsed["mcp"]["other"]["timeout"], 5000);
        assert_eq!(
            parsed["mcp"]["servers"]["codeg-mcp"]["timeout"],
            CODEG_MCP_TIMEOUT_MS
        );
    }

    #[test]
    fn codeg_mcp_timeout_preserves_string_escapes_and_avoids_marker_collisions() {
        let raw = r#"{
            /* " {file:IGNORED} */
            "literal": "__codeg_config_literal_0__",
            "quoted": "quote: \"{env:PRIVATE_TOKEN}\"; slash: \\",
            "escaped": "\u007benv:DO_NOT_EXPAND}",
            "mcp": {"other": {"type": "local", "command": ["{file:./a\\b.txt}"]}},
        }"#;
        let merged = with_codeg_mcp_timeout(raw).unwrap();
        let original = crate::acp::opencode_config::parse(raw).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&merged).unwrap();
        assert_eq!(parsed["literal"], original["literal"]);
        assert_eq!(parsed["quoted"], original["quoted"]);
        assert_eq!(parsed["escaped"], original["escaped"]);
        assert_eq!(parsed["mcp"]["other"], original["mcp"]["other"]);
        assert!(merged.contains(r#""\u007benv:DO_NOT_EXPAND}""#));
        assert!(merged.contains(r#""{file:./a\\b.txt}""#));
    }

    #[test]
    fn codeg_mcp_timeout_rejects_unicode_escaped_marker_key() {
        let raw =
            r#"{"mcp":{"\u005f_codeg_config_literal_0__":{"type":"local","command":["other"]}}}"#;
        let reason = with_codeg_mcp_timeout(raw).unwrap_err();
        assert_eq!(
            reason,
            "OpenCode 启动配置对象键与占位符冲突，保留原配置并跳过期限注入"
        );
    }

    #[test]
    fn codeg_mcp_timeout_rejects_nested_marker_keys() {
        for raw in [
            r#"{"mcp":{"other":{"type":"local","command":["other"],"nested":{"\u005f_codeg_config_literal_0__":true}}}}"#,
            r#"{"mcp":{"other":{"type":"local","command":["other"]}},"nested":[{"\u005f_codeg_config_literal_1__":true}]}"#,
        ] {
            assert!(with_codeg_mcp_timeout(raw).is_err());
        }
    }

    #[test]
    fn codeg_mcp_timeout_reports_unsafe_injection_without_exposing_config() {
        let raw = r#"{"mcp": {env:PRIVATE_MCP_CONFIG}}"#;
        let reason = with_codeg_mcp_timeout(raw).unwrap_err();
        assert!(!reason.contains("PRIVATE_MCP_CONFIG"));
        assert!(with_codeg_mcp_timeout(r#"{"value": {file:unfinished"#).is_err());
        assert!(with_codeg_mcp_timeout(r#"{"{env:PRIVATE_KEY}": {}}"#).is_err());
    }

    #[test]
    fn codeg_mcp_timeout_preserves_duplicate_key_semantics_with_comments_and_escapes() {
        let raw = r#"{"mcp": {
            "other" /* 键与冒号之间允许注释 */: {"timeout": 1},
            "\u006fther": {"timeout": 5000}
        }}"#;
        let merged: serde_json::Value =
            serde_json::from_str(&with_codeg_mcp_timeout(raw).unwrap()).unwrap();
        assert_eq!(merged["mcp"]["other"]["timeout"], 5000);
        assert_eq!(merged["mcp"].as_object().unwrap().len(), 2);
    }

    #[test]
    fn a_1x_release_is_refused_and_2x_is_not() {
        assert!(is_pre_v2_release("1.19.3"));
        assert!(is_pre_v2_release("1.19.4"));
        assert!(is_pre_v2_release(" 1.18.33\n"));
        assert!(is_pre_v2_release("1.0.41"));
        assert!(is_pre_v2_release("0.15.31"));
        // A prerelease of a 1.x line is still 1.x.
        assert!(is_pre_v2_release("1.19.5-beta.1"));

        assert!(!is_pre_v2_release("2.0.0"));
        assert!(!is_pre_v2_release("2.2.0"));
        assert!(!is_pre_v2_release("2.0.0-rc.1"));
        assert!(!is_pre_v2_release("3.0.0"));
    }

    #[test]
    fn a_preview_or_unreadable_version_is_never_refused() {
        // Real npm versions from both preview-number schemes: their age is
        // unknowable from the number, so they launch.
        assert!(!is_pre_v2_release("0.0.0-1748650942428"));
        assert!(!is_pre_v2_release("0.0.0-dev-202609282300"));
        assert!(!is_pre_v2_release("0.0.0"));
        assert!(!is_pre_v2_release("local"));
        assert!(!is_pre_v2_release(""));
        assert!(!is_pre_v2_release("1.19"));
    }

    /// The pin itself must launch, or every managed install would be refused.
    #[test]
    fn the_pinned_release_is_not_refused() {
        let AgentDistribution::Binary { version, args, .. } =
            registry::get_agent_meta(AgentType::OpenCode).distribution
        else {
            panic!("OpenCode is a binary agent");
        };
        assert!(!is_pre_v2_release(version));
        assert_eq!(args, ["acp"], "OpenCode 2's acp takes no listen flags");
    }

    #[tokio::test]
    async fn a_managed_label_decides_without_running_anything() {
        // Nothing exists at this path, so no probe could have answered.
        let missing = Path::new("/nonexistent/codeg-443/opencode");
        assert_eq!(
            pre_v2_runtime(missing, Some("1.19.3")).await.as_deref(),
            Some("1.19.3")
        );
        assert_eq!(pre_v2_runtime(missing, Some("2.2.0")).await, None);
        // A PATH binary that cannot be asked is not refused.
        assert_eq!(pre_v2_runtime(missing, None).await, None);
    }

    /// A stand-in `opencode` answering `--version` with `banner`.
    #[cfg(unix)]
    fn fake_opencode(dir: &Path, banner: &str) -> PathBuf {
        let bin = dir.join("opencode");
        let script = format!(
            "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo '{banner}'; exit 0; fi\nexit 1\n"
        );
        crate::process::write_test_script(&bin, &script);
        bin
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_path_binary_is_judged_by_its_version_banner() {
        // 1.x prints the bare version; 2.x prints `opencode v<version>`.
        let dir = tempfile::tempdir().expect("tempdir");
        let old = fake_opencode(dir.path(), "1.19.3");
        assert_eq!(pre_v2_runtime(&old, None).await.as_deref(), Some("1.19.3"));

        let dir = tempfile::tempdir().expect("tempdir");
        let current = fake_opencode(dir.path(), "opencode v2.2.0");
        assert_eq!(pre_v2_runtime(&current, None).await, None);
    }

    #[test]
    fn the_message_names_the_version_and_the_way_out() {
        let bin = Path::new("/usr/local/bin/opencode");
        let managed = runtime_outdated_message("1.19.3", bin, true, "2.2.0");
        assert!(managed.contains("OpenCode 1.19.3"), "{managed}");
        assert!(managed.contains("2.2.0"), "{managed}");
        assert!(managed.contains("Agent Settings"), "{managed}");

        let system = runtime_outdated_message("1.18.33", bin, false, "2.2.0");
        assert!(system.contains("/usr/local/bin/opencode"), "{system}");
        assert!(system.contains("1.18.33"), "{system}");
        assert!(system.contains("opencode upgrade --major"), "{system}");
    }
}
