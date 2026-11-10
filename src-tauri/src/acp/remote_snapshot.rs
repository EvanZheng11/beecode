//! 桌面用户发送边界的远程上下文；不修改用户块，也不写入授权数据库。
use super::types::{PromptInputBlock, RemoteSnapshotDegraded};
use base64::Engine;
use futures::{stream, StreamExt};
use serde_json::{json, Value};
use std::{collections::HashSet, future::Future, time::Duration};
use tokio::time::{timeout, timeout_at, Instant};

const FILE_LIMIT: usize = 256 * 1024;
const MESSAGE_LIMIT: usize = 1024 * 1024;
const TURN_LIMIT: usize = 4 * 1024;
const SESSION_LIMIT: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RemoteTarget {
    File { folder_id: i32, path: String },
    Session { conversation_id: i32 },
    Assistant { folder_id: i32, assistant_id: i32 },
    Agent { folder_id: i32, agent: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteReference {
    pub uri: String,
    pub connection_id: i32,
    pub target: RemoteTarget,
}

fn positive_id(raw: &str) -> Option<i32> {
    if raw.is_empty()
        || raw.len() > 10
        || raw.starts_with('0')
        || !raw.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    raw.parse::<i32>().ok().filter(|n| *n > 0)
}

fn decode_segment(raw: &str) -> Option<String> {
    // urlencoding 对孤立的 % 保持原样，所以先显式验证百分号转义。
    let bytes = raw.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() || !bytes[i + 1..i + 3].iter().all(u8::is_ascii_hexdigit) {
                return None;
            }
            i += 3;
        } else {
            i += 1;
        }
    }
    let decoded = urlencoding::decode(raw).ok()?.into_owned();
    if decoded.is_empty() || decoded.chars().any(char::is_control) || decoded.contains(['/', '\\'])
    {
        return None;
    }
    Some(decoded)
}

/// 严格解析设计 5.2 的四类 URI，供远程委派路径共用；不接受显示用绝对目录。
pub fn parse_remote_uri(uri: &str) -> Option<RemoteReference> {
    let rest = uri.strip_prefix("codeg://remote/")?;
    if rest.contains('#') || rest.chars().any(char::is_whitespace) {
        return None;
    }
    let (conn, rest) = rest.split_once('/')?;
    let connection_id = positive_id(conn)?;
    let (kind, rest) = rest.split_once('/')?;
    let target = match kind {
        "file" => {
            let (folder, path) = rest.split_once('/')?;
            if path.contains('?') {
                return None;
            }
            let segments: Vec<String> =
                path.split('/').map(decode_segment).collect::<Option<_>>()?;
            if segments
                .iter()
                .any(|s| s == "." || s == ".." || s.contains(':'))
            {
                return None;
            }
            RemoteTarget::File {
                folder_id: positive_id(folder)?,
                path: segments.join("/"),
            }
        }
        "session" => RemoteTarget::Session {
            conversation_id: positive_id(rest)?,
        },
        "assistant" | "agent" => {
            let (target, folder) = rest.split_once("?folder=")?;
            let folder_id = positive_id(folder)?;
            if kind == "assistant" {
                RemoteTarget::Assistant {
                    folder_id,
                    assistant_id: positive_id(target)?,
                }
            } else {
                RemoteTarget::Agent {
                    folder_id,
                    agent: decode_segment(target)?,
                }
            }
        }
        _ => return None,
    };
    Some(RemoteReference {
        uri: uri.into(),
        connection_id,
        target,
    })
}

/// 只扫描用户文本；不扫描附件正文、资源元数据或智能体输出。按出现顺序去重。
pub fn collect_remote_references(blocks: &[PromptInputBlock]) -> Vec<RemoteReference> {
    let mut seen = HashSet::new();
    let mut references = Vec::new();
    for block in blocks {
        let PromptInputBlock::Text { text } = block else {
            continue;
        };
        for (start, _) in text.match_indices("codeg://remote/") {
            let candidate = text[start..]
                .split(|c: char| {
                    c.is_whitespace() || matches!(c, ')' | ']' | '>' | '<' | '"' | '`')
                })
                .next()
                .unwrap_or("");
            if let Some(reference) = parse_remote_uri(candidate) {
                if seen.insert(reference.uri.clone()) {
                    references.push(reference);
                }
            }
        }
    }
    references
}

#[derive(Default)]
pub struct PreparedSnapshot {
    pub suffix: Vec<PromptInputBlock>,
    pub degraded: Vec<RemoteSnapshotDegraded>,
    /// 仅收集；主会话集成方在成功绑定父会话后、send_prompt_inner 前写库。
    pub grants: Vec<(i32, i32)>,
}

struct Fetched {
    grant: Option<i32>,
    content: Option<Result<String, RemoteSnapshotDegraded>>,
}

fn degraded(uri: &str, reason: &str, bytes: Option<usize>) -> RemoteSnapshotDegraded {
    RemoteSnapshotDegraded {
        uri: uri.into(),
        reason: reason.into(),
        bytes,
    }
}

fn decode_file(uri: &str, value: Value) -> Result<String, RemoteSnapshotDegraded> {
    let encoded = value
        .as_str()
        .ok_or_else(|| degraded(uri, "invalid_response", None))?;
    if encoded.len() > FILE_LIMIT.div_ceil(3) * 4 {
        return Err(degraded(uri, "file_too_large", Some(encoded.len() / 4 * 3)));
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| degraded(uri, "invalid_base64", None))?;
    if bytes.len() > FILE_LIMIT {
        return Err(degraded(uri, "file_too_large", Some(bytes.len())));
    }
    if bytes.iter().take(8192).any(|b| *b == 0) {
        return Err(degraded(uri, "binary_file", Some(bytes.len())));
    }
    let len = bytes.len();
    String::from_utf8(bytes).map_err(|_| degraded(uri, "invalid_utf8", Some(len)))
}

fn append_bounded(out: &mut String, text: &str, limit: usize) {
    let mut end = text.len().min(limit.saturating_sub(out.len()));
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    out.push_str(&text[..end]);
}

fn session_summary(uri: &str, value: &Value) -> Result<(i32, String), RemoteSnapshotDegraded> {
    let summary = &value["summary"];
    let folder_id = summary["folder_id"]
        .as_i64()
        .and_then(|id| i32::try_from(id).ok())
        .filter(|id| *id > 0)
        .ok_or_else(|| degraded(uri, "invalid_response", None))?;
    let turns = value["turns"]
        .as_array()
        .ok_or_else(|| degraded(uri, "invalid_response", None))?;
    let mut out = String::new();
    append_bounded(
        &mut out,
        &format!(
            "标题：{}\n智能体：{}\n状态：{}\n",
            summary["title"].as_str().unwrap_or("未命名"),
            summary["agent_type"].as_str().unwrap_or("未知"),
            summary["status"].as_str().unwrap_or("未知")
        ),
        SESSION_LIMIT,
    );
    if summary["status"].as_str() == Some("in_progress")
        || value["in_flight_user_turn_id"].is_string()
    {
        append_bounded(
            &mut out,
            &format!(
                "会话仍在进行，内容截至 {}\n",
                chrono::Local::now().format("%H:%M")
            ),
            SESSION_LIMIT,
        );
    }
    for turn in turns.iter().skip(turns.len().saturating_sub(10)) {
        let mut text = String::new();
        append_bounded(
            &mut text,
            &format!("\n[{}]\n", turn["role"].as_str().unwrap_or("未知")),
            TURN_LIMIT,
        );
        if let Some(blocks) = turn["blocks"].as_array() {
            for block in blocks {
                match block["type"].as_str() {
                    Some("text") => {
                        append_bounded(&mut text, block["text"].as_str().unwrap_or(""), TURN_LIMIT)
                    }
                    Some("tool_use") => append_bounded(
                        &mut text,
                        &format!(
                            "\n[工具] {} {}\n",
                            block["tool_name"].as_str().unwrap_or("未知"),
                            block["status"].as_str().unwrap_or("未知")
                        ),
                        TURN_LIMIT,
                    ),
                    _ => {}
                }
            }
        }
        append_bounded(&mut out, &text, SESSION_LIMIT);
    }
    Ok((folder_id, out))
}

async fn fetch<F, Fut>(reference: &RemoteReference, call: &F) -> Fetched
where
    F: Fn(i32, &'static str, Value) -> Fut,
    Fut: Future<Output = Result<Value, &'static str>>,
{
    let conn = reference.connection_id;
    let uri = &reference.uri;
    match &reference.target {
        RemoteTarget::Assistant { folder_id, .. } | RemoteTarget::Agent { folder_id, .. } => {
            Fetched {
                grant: Some(*folder_id),
                content: None,
            }
        }
        RemoteTarget::File { folder_id, path } => {
            let content = async {
                let folders = call(conn, "list_all_folder_details", json!({}))
                    .await
                    .map_err(|_| degraded(uri, "remote_unavailable", None))?;
                let root = folders
                    .as_array()
                    .and_then(|items| {
                        items
                            .iter()
                            .find(|f| f["id"].as_i64() == Some(i64::from(*folder_id)))
                    })
                    .and_then(|f| f["path"].as_str())
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| degraded(uri, "unknown_folder", None))?;
                let value = call(
                    conn,
                    "read_workspace_file_base64",
                    json!({"rootPath":root,"path":path,"maxBytes":FILE_LIMIT}),
                )
                .await
                .map_err(|reason| degraded(uri, reason, None))?;
                decode_file(uri, value)
            }
            .await;
            Fetched {
                grant: Some(*folder_id),
                content: Some(content),
            }
        }
        RemoteTarget::Session { conversation_id } => {
            let content = match call(
                conn,
                "get_folder_conversation",
                json!({"conversationId":conversation_id,"tailTurns":10}),
            )
            .await
            {
                Ok(value) => session_summary(uri, &value),
                Err(reason) => Err(degraded(uri, reason, None)),
            };
            match content {
                Ok((folder, text)) => Fetched {
                    grant: Some(folder),
                    content: Some(Ok(text)),
                },
                Err(error) => Fetched {
                    grant: None,
                    content: Some(Err(error)),
                },
            }
        }
    }
}

/// 所有 IO 有界；按引用顺序装入预算，不让完成速度决定哪些正文可进入提示词。
async fn prepare_with<F, Fut>(
    references: &[RemoteReference],
    embedded: bool,
    call: F,
    item_timeout: Duration,
    total_timeout: Duration,
) -> PreparedSnapshot
where
    F: Fn(i32, &'static str, Value) -> Fut,
    Fut: Future<Output = Result<Value, &'static str>>,
{
    let deadline = Instant::now() + total_timeout;
    let mut results = stream::iter(references.iter().cloned().enumerate().map(|(index, reference)| {
        let call = &call;
        async move {
            // 路由引用只收集授权，不因文件队列耗尽时间预算而生成快照。
            if matches!(
                reference.target,
                RemoteTarget::Assistant { .. } | RemoteTarget::Agent { .. }
            ) {
                return (index, fetch(&reference, call).await);
            }
            let result = if Instant::now() >= deadline {
                None
            } else {
                Some(timeout_at(deadline, timeout(item_timeout, fetch(&reference, call))).await)
            };
            let fetched = match result {
                Some(Ok(Ok(fetched))) => fetched,
                _ => Fetched {
                    grant: match reference.target {
                        RemoteTarget::File { folder_id, .. }
                        | RemoteTarget::Assistant { folder_id, .. }
                        | RemoteTarget::Agent { folder_id, .. } => Some(folder_id),
                        _ => None,
                    },
                    content: Some(Err(degraded(&reference.uri, "timeout", None))),
                },
            };
            (index, fetched)
        }
    }))
    .buffered(4);
    let mut prepared = PreparedSnapshot::default();
    let mut used = 0;
    while let Some((index, fetched)) = results.next().await {
        let reference = &references[index];
        if let Some(folder) = fetched.grant {
            let grant = (reference.connection_id, folder);
            if !prepared.grants.contains(&grant) {
                prepared.grants.push(grant);
            }
        }
        let Some(content) = fetched.content else {
            continue;
        };
        let content = content.and_then(|text| {
            if used + text.len() > MESSAGE_LIMIT {
                Err(degraded(
                    &reference.uri,
                    "message_too_large",
                    Some(text.len()),
                ))
            } else {
                used += text.len();
                Ok(text)
            }
        });
        match content {
            Ok(text) if embedded => prepared.suffix.push(PromptInputBlock::Resource {
                uri: reference.uri.clone(),
                mime_type: Some("text/plain".into()),
                text: Some(text),
                blob: None,
            }),
            Ok(text) => prepared.suffix.push(PromptInputBlock::Text {
                text: format!(
                    "{}\n<context ref=\"{}\">\n{}\n</context>",
                    reference.uri, reference.uri, text
                ),
            }),
            Err(error) => {
                prepared.suffix.push(PromptInputBlock::Text {
                    text: format!(
                        "{}\n远程快照不可用（{}）；请用远程智能体处理。",
                        error.uri,
                        match error.reason.as_str() {
                            "file_too_large" => "文件超过 256 KiB 快照上限",
                            "message_too_large" => "消息快照总量超过 1 MiB 上限",
                            "binary_file" | "invalid_utf8" => "文件不是 UTF-8 文本",
                            "timeout" => "获取超时",
                            "unknown_folder" => "远程项目未登记",
                            _ => "远程读取失败",
                        }
                    ),
                });
                prepared.degraded.push(error);
            }
        }
    }
    prepared
}

#[cfg(test)]
type TestCall = std::sync::Arc<
    dyn Fn(
            i32,
            &'static str,
            Value,
        ) -> futures::future::BoxFuture<'static, Result<Value, &'static str>>
        + Send
        + Sync,
>;
#[cfg(test)]
tokio::task_local! { static TEST_CALL: TestCall; }

/// 测试专用、task-local 的网关替换，不影响并行测试或生产发送。
#[cfg(test)]
pub(crate) async fn with_test_gateway<F, Fut, T>(call: F, task: impl Future<Output = T>) -> T
where
    F: Fn(i32, &'static str, Value) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = Result<Value, &'static str>> + Send + 'static,
{
    TEST_CALL
        .scope(
            std::sync::Arc::new(move |c, cmd, args| Box::pin(call(c, cmd, args))),
            task,
        )
        .await
}

pub async fn prepare(
    db: &crate::db::AppDatabase,
    references: &[RemoteReference],
    embedded: bool,
) -> PreparedSnapshot {
    prepare_with(
        references,
        embedded,
        |connection_id, command, args| async move {
            #[cfg(test)]
            if let Ok(call) = TEST_CALL.try_with(Clone::clone) {
                return call(connection_id, command, args).await;
            }
            // 网关负责 hello 和白名单；不回传可能含服务端正文或凭证的错误文案。
            crate::remote_gateway::call_allowed(
                db,
                connection_id,
                command,
                Some(args),
                Some(15_000),
            )
            .await
            .map_err(|error| {
                // 只识别受控的远端标准错误，不把远端自由文案放进事件或提示词。
                if error.message == "File is too large to attach" {
                    "file_too_large"
                } else {
                    "read_failed"
                }
            })
        },
        Duration::from_secs(15),
        Duration::from_secs(30),
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    fn refs(text: &str) -> Vec<RemoteReference> {
        collect_remote_references(&[PromptInputBlock::Text { text: text.into() }])
    }

    #[test]
    fn parses_four_kinds_and_rejects_ambiguous_paths() {
        for uri in [
            "codeg://remote/1/file/2/src/a%20b.rs",
            "codeg://remote/1/session/3",
            "codeg://remote/1/assistant/4?folder=2",
            "codeg://remote/1/agent/custom%3Aa?folder=2",
        ] {
            assert!(parse_remote_uri(uri).is_some(), "{uri}");
        }
        for uri in [
            "codeg://remote/0/session/1",
            "codeg://remote/01/session/1",
            "codeg://remote/2147483648/session/1",
            "codeg://remote/1/file/2/%2e%2e/a",
            "codeg://remote/1/file/2/%2fa",
            "codeg://remote/1/file/2/a%",
            "codeg://remote/1/agent/a?folder=2&x=3",
            "codeg://remote/1/file/2/a%00",
        ] {
            assert!(parse_remote_uri(uri).is_none(), "{uri}");
        }
        assert_eq!(
            refs("[a](codeg://remote/1/file/2/a) [a](codeg://remote/1/file/2/a)").len(),
            1
        );
        assert!(collect_remote_references(&[PromptInputBlock::Resource {
            uri: "codeg://remote/1/session/2".into(),
            mime_type: None,
            text: None,
            blob: None
        }])
        .is_empty());
    }

    #[test]
    fn encoded_parentheses_survive_markdown_reference_scan() {
        let references = refs("[括号文件](codeg://remote/1/file/2/src/a%281%29.ts)");
        assert_eq!(references.len(), 1);
        assert_eq!(references[0].uri, "codeg://remote/1/file/2/src/a%281%29.ts");
        assert_eq!(references[0].target, RemoteTarget::File {
            folder_id: 2,
            path: "src/a(1).ts".into(),
        });
    }

    #[tokio::test]
    async fn success_fallback_grants_and_no_links() {
        let references = refs("[a](codeg://remote/1/file/2/a) [s](codeg://remote/1/session/3) [r](codeg://remote/1/agent/pi?folder=4)");
        for embedded in [false, true] {
            let prepared = prepare_with(&references, embedded, |_, command, args| async move {
                Ok(match command {
                    "list_all_folder_details" => json!([{"id":2,"path":"/remote/project"}]),
                    "read_workspace_file_base64" => {
                        assert_eq!(args, json!({"rootPath":"/remote/project","path":"a","maxBytes":262144}));
                        json!(base64::engine::general_purpose::STANDARD.encode("私有正文"))
                    }
                    "get_folder_conversation" => {
                        assert_eq!(args, json!({"conversationId":3,"tailTurns":10}));
                        json!({"summary":{"folder_id":5,"title":"会话","agent_type":"pi","status":"in_progress"},"turns":[{"role":"assistant","blocks":[{"type":"text","text":"摘要"},{"type":"tool_use","tool_name":"read","status":"completed","input_preview":"不应注入"},{"type":"tool_result","output_preview":"不应注入"}]}]})
                    }
                    _ => panic!("禁止其他路由"),
                })
            }, Duration::from_secs(1), Duration::from_secs(1)).await;
            assert!(prepared.degraded.is_empty());
            assert_eq!(prepared.grants, [(1, 2), (1, 5), (1, 4)]);
            assert_eq!(prepared.suffix.len(), 2);
            assert_eq!(
                matches!(prepared.suffix[0], PromptInputBlock::Resource { .. }),
                embedded
            );
            let wire = serde_json::to_string(&prepared.suffix).unwrap();
            assert!(wire.contains("私有正文"));
            assert!(wire.contains("会话仍在进行"));
            assert!(wire.contains("[工具] read completed"));
            assert!(!wire.contains("不应注入"));
        }
        let empty = prepare_with(
            &[],
            false,
            |_, _, _| async {
                panic!("无链接不调用网关");
                #[allow(unreachable_code)]
                Ok(Value::Null)
            },
            Duration::from_secs(1),
            Duration::from_secs(1),
        )
        .await;
        assert!(empty.suffix.is_empty() && empty.grants.is_empty());
    }

    #[test]
    fn strict_text_and_session_bounds() {
        let uri = "codeg://remote/1/file/2/a";
        for (bytes, reason) in [
            (vec![0; 4], "binary_file"),
            (vec![255; 4], "invalid_utf8"),
            (vec![b'a'; FILE_LIMIT + 1], "file_too_large"),
        ] {
            assert_eq!(
                decode_file(
                    uri,
                    json!(base64::engine::general_purpose::STANDARD.encode(bytes))
                )
                .unwrap_err()
                .reason,
                reason
            );
        }
        let text = "界".repeat(4000);
        let value = json!({"summary":{"folder_id":2},"turns":(0..20).map(|_| json!({"role":"user","blocks":[{"type":"text","text":text}]})).collect::<Vec<_>>()});
        let (_, summary) = session_summary(uri, &value).unwrap();
        assert!(summary.len() <= SESSION_LIMIT);
        assert_eq!(summary.matches("[user]").count(), 10);
        assert!(summary.len() <= 10 * TURN_LIMIT + 128);
    }

    #[tokio::test]
    async fn budget_is_in_reference_order_and_concurrency_is_four() {
        let references = refs(
            &(0..8)
                .map(|i| format!("[a](codeg://remote/1/file/2/{i}) "))
                .collect::<String>(),
        );
        let active = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let result = prepare_with(
            &references,
            true,
            |_, command, _| {
                let active = active.clone();
                let peak = peak.clone();
                async move {
                    let now = active.fetch_add(1, Ordering::SeqCst) + 1;
                    peak.fetch_max(now, Ordering::SeqCst);
                    tokio::task::yield_now().await;
                    active.fetch_sub(1, Ordering::SeqCst);
                    Ok(if command == "list_all_folder_details" {
                        json!([{"id":2,"path":"/r"}])
                    } else {
                        json!(base64::engine::general_purpose::STANDARD
                            .encode(vec![b'a'; FILE_LIMIT]))
                    })
                }
            },
            Duration::from_secs(5),
            Duration::from_secs(5),
        )
        .await;
        assert_eq!(peak.load(Ordering::SeqCst), 4);
        assert_eq!(result.degraded.len(), 4);
        assert_eq!(result.degraded[0].uri, "codeg://remote/1/file/2/4");
        assert!(result
            .degraded
            .iter()
            .all(|d| d.reason == "message_too_large"));
    }

    #[tokio::test]
    async fn overall_deadline_does_not_snapshot_routes_or_start_late_io() {
        let references = refs("[a](codeg://remote/1/file/2/a) [b](codeg://remote/1/file/2/b) [c](codeg://remote/1/file/2/c) [d](codeg://remote/1/file/2/d) [e](codeg://remote/1/file/2/e) [r](codeg://remote/1/agent/pi?folder=4)");
        let calls = AtomicUsize::new(0);
        let prepared = prepare_with(
            &references,
            false,
            |_, _, _| {
                calls.fetch_add(1, Ordering::SeqCst);
                async {
                    futures::future::pending::<()>().await;
                    Ok(Value::Null)
                }
            },
            Duration::from_secs(1),
            Duration::from_millis(5),
        )
        .await;
        assert_eq!(
            calls.load(Ordering::SeqCst),
            4,
            "总超时后不得为队列后项发起网络IO"
        );
        assert_eq!(prepared.degraded.len(), 5);
        assert_eq!(prepared.suffix.len(), 5, "路由引用不得生成降级快照");
        assert_eq!(prepared.grants, [(1, 2), (1, 4)]);
        let empty = with_test_gateway(
            |_, _, _| async {
                panic!("无链接不调用mock");
                #[allow(unreachable_code)]
                Ok(Value::Null)
            },
            prepare_with(
                &[],
                false,
                |_, _, _| async { Ok(Value::Null) },
                Duration::from_secs(1),
                Duration::from_secs(1),
            ),
        )
        .await;
        assert!(empty.grants.is_empty());
    }

    #[tokio::test]
    async fn timeout_and_failure_are_pointers_not_body_or_error_echoes() {
        let references = refs("[a](codeg://remote/1/file/2/a)");
        for wait in [false, true] {
            let result = prepare_with(
                &references,
                false,
                |_, _, _| async move {
                    if wait {
                        futures::future::pending::<()>().await;
                    }
                    Err("read_failed")
                },
                Duration::from_millis(5),
                Duration::from_millis(10),
            )
            .await;
            assert_eq!(result.grants, [(1, 2)]);
            assert_eq!(result.degraded.len(), 1);
            assert_eq!(
                result.degraded[0].reason,
                if wait {
                    "timeout"
                } else {
                    "remote_unavailable"
                }
            );
            assert!(matches!(result.suffix[0], PromptInputBlock::Text { .. }));
        }
    }
}
