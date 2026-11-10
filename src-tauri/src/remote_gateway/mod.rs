//! 跨运行时远程网关；新功能只能使用白名单入口，旧远程桌面保留完整代理。

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::LazyLock;
use std::time::{Duration, Instant};

use reqwest::{Method, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;

use crate::app_error::{AppCommandError, AppErrorCode};
use crate::cli_run::{hello as hello_proof, wire};
use crate::db::{service::remote_workspace_connection_service, AppDatabase};
use crate::models::{RemoteWorkspaceConnectionInfo, ToHeaderMap};

const HTTP_TIMEOUT: Duration = Duration::from_secs(30);
const HELLO_TTL: Duration = Duration::from_secs(600);
pub const HTTP_TIMEOUT_MAX: Duration = Duration::from_secs(600);

/// 设计 7.1 的固定路由；不做 trim、URL 解码或接受路径片段。
pub const ALLOWED_ROUTES: &[&str] = &[
    "cli_hello",
    "list_all_folder_details",
    "list_workspace_files",
    "read_workspace_file_base64",
    "list_all_conversations",
    "get_folder_conversation",
    "cli_assistants",
    "cli_agents",
    "cli_run_reserve",
    "cli_run_start",
    "cli_run_events",
    "cli_run_get",
    "cli_run_cancel",
    "cli_run_find",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteCapabilities {
    pub runtime: wire::RuntimeKind,
    pub version: String,
    pub api_version: u32,
    pub capabilities: Vec<String>,
}

struct HelloCacheEntry {
    at: Instant,
    capabilities: RemoteCapabilities,
}
static HELLOS: LazyLock<Mutex<HashMap<String, HelloCacheEntry>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

// 新入口不跟随任何重定向，保证 proof 验证和后续请求命中同一配置地址。
static ALLOWED_HTTP: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("远程网关客户端初始化失败")
});
static LEGACY_HTTP: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if let Some(previous) = attempt.previous().last() {
                let next = attempt.url();
                if previous.scheme() != next.scheme()
                    || previous.host_str() != next.host_str()
                    || previous.port_or_known_default() != next.port_or_known_default()
                {
                    return attempt.error("refused a redirect to another remote origin");
                }
            }
            if attempt.previous().len() > 10 {
                return attempt.error("more than 10 redirects");
            }
            attempt.follow()
        }))
        .build()
        .expect("远程桌面客户端初始化失败")
});

async fn connection(
    db: &AppDatabase,
    id: i32,
) -> Result<RemoteWorkspaceConnectionInfo, AppCommandError> {
    remote_workspace_connection_service::get(&db.conn, id)
        .await
        .map_err(AppCommandError::db)?
        .ok_or_else(|| AppCommandError::not_found(format!("Remote connection {id} not found")))
}

// 缓存只保留不可逆指纹，不在常驻缓存保存 token 或自定义认证头。
fn fingerprint(conn: &RemoteWorkspaceConnectionInfo) -> String {
    let encoded = serde_json::to_vec(&(conn.id, &conn.base_url, &conn.token, &conn.headers))
        .expect("连接字段可序列化");
    format!("{:x}", Sha256::digest(encoded))
}

pub(crate) async fn connection_key(db: &AppDatabase, id: i32) -> Result<String, AppCommandError> {
    Ok(fingerprint(&connection(db, id).await?))
}

fn endpoint(
    conn: &RemoteWorkspaceConnectionInfo,
    command: &str,
) -> Result<String, AppCommandError> {
    let base = reqwest::Url::parse(&conn.base_url)
        .map_err(|_| AppCommandError::invalid_input("远程连接地址无效"))?;
    if !matches!(base.scheme(), "http" | "https")
        || base.host_str().is_none()
        || !base.username().is_empty()
        || base.password().is_some()
        || base.query().is_some()
        || base.fragment().is_some()
    {
        return Err(AppCommandError::invalid_input(
            "远程地址必须为不含凭据、查询或片段的 HTTP(S) 地址",
        ));
    }
    Ok(format!(
        "{}/api/{command}",
        conn.base_url.trim_end_matches('/')
    ))
}

fn timeout(ms: Option<u64>) -> Duration {
    ms.map(Duration::from_millis)
        .unwrap_or(HTTP_TIMEOUT)
        .min(HTTP_TIMEOUT_MAX)
}

pub async fn hello(
    db: &AppDatabase,
    connection_id: i32,
) -> Result<RemoteCapabilities, AppCommandError> {
    hello_connection(&connection(db, connection_id).await?).await
}

async fn hello_connection(
    conn: &RemoteWorkspaceConnectionInfo,
) -> Result<RemoteCapabilities, AppCommandError> {
    let key = fingerprint(conn);
    {
        let mut cache = HELLOS.lock().await;
        cache.retain(|_, entry| entry.at.elapsed() < HELLO_TTL);
        if let Some(entry) = cache.get(&key) {
            return Ok(entry.capabilities.clone());
        }
    }
    let nonce = hello_proof::random_hex(16);
    let start = Instant::now();
    // 此阶段既不带 Bearer token，也不带可能含认证信息的自定义 headers。
    let response = ALLOWED_HTTP
        .post(endpoint(conn, "cli_hello")?)
        .timeout(Duration::from_secs(8))
        .json(&wire::HelloRequest {
            nonce: nonce.clone(),
            client_version: env!("CARGO_PKG_VERSION").into(),
            api_version: wire::API_VERSION,
        })
        .send()
        .await
        .map_err(|error| {
            tracing::warn!("[remote-mention] connection_id={} route=cli_hello elapsed_ms={} error_code=network_error", conn.id, start.elapsed().as_millis());
            network_error(error)
        })?;
    tracing::info!(
        "[remote-mention] connection_id={} route=cli_hello status={} elapsed_ms={} bytes={}",
        conn.id,
        response.status().as_u16(),
        start.elapsed().as_millis(),
        response.content_length().unwrap_or(0)
    );
    let value = decode_response(response).await?;
    let answer: wire::HelloResponse = serde_json::from_value(value)
        .map_err(|_| AppCommandError::network("远程 hello 响应格式无效"))?;
    if !hello_proof::verify(conn.token.trim(), &nonce, None, &answer.proof) {
        return Err(AppCommandError::authentication_failed(
            "远程身份验证失败，请检查地址和 token",
        ));
    }
    if answer.api_version != wire::API_VERSION {
        return Err(AppCommandError::configuration_invalid(
            "远程 CLI API 版本不兼容",
        ));
    }
    let capabilities = RemoteCapabilities {
        runtime: answer.runtime,
        version: answer.version,
        api_version: answer.api_version,
        capabilities: answer.capabilities,
    };
    HELLOS.lock().await.insert(
        key,
        HelloCacheEntry {
            at: Instant::now(),
            capabilities: capabilities.clone(),
        },
    );
    Ok(capabilities)
}

pub async fn call_allowed(
    db: &AppDatabase,
    connection_id: i32,
    command: &str,
    args: Option<Value>,
    timeout_ms: Option<u64>,
) -> Result<Value, AppCommandError> {
    if !ALLOWED_ROUTES.contains(&command) {
        return Err(AppCommandError::permission_denied("远程命令不在允许列表中"));
    }
    let conn = connection(db, connection_id).await?;
    // cli_hello 也必须经随机挑战验证，不允许调用方提供 nonce 绕过验证。
    let capabilities = hello_connection(&conn).await?;
    if command == "cli_hello" {
        return serde_json::to_value(capabilities)
            .map_err(|_| AppCommandError::network("能力响应序列化失败"));
    }
    send(&ALLOWED_HTTP, &conn, command, args, timeout_ms).await
}

/// 仅供既有远程桌面使用；不增加 hello 依赖，以兼容旧远端。
pub async fn call_any(
    db: &AppDatabase,
    connection_id: i32,
    command: &str,
    args: Option<Value>,
    timeout_ms: Option<u64>,
) -> Result<Value, AppCommandError> {
    send(
        &LEGACY_HTTP,
        &connection(db, connection_id).await?,
        command,
        args,
        timeout_ms,
    )
    .await
}

fn route(command: &str) -> (Method, &str) {
    match command {
        "get_resource_monitor_settings" => (Method::GET, "resource-monitor/settings"),
        "set_resource_monitor_enabled" => (Method::PUT, "resource-monitor/settings"),
        "get_resource_monitor_snapshot" => (Method::GET, "resource-monitor/snapshot"),
        "resource_monitor_process_action" => (Method::POST, "resource-monitor/action"),
        _ => (Method::POST, command.trim_start_matches('/')),
    }
}

async fn send(
    client: &reqwest::Client,
    conn: &RemoteWorkspaceConnectionInfo,
    command: &str,
    args: Option<Value>,
    timeout_ms: Option<u64>,
) -> Result<Value, AppCommandError> {
    let (method, path) = route(command);
    let has_body = method != Method::GET;
    let mut request = client
        .request(method, endpoint(conn, path)?)
        .headers(conn.headers.to_header_map())
        .bearer_auth(conn.token.trim())
        .timeout(timeout(timeout_ms));
    if has_body {
        request = request.json(&args.unwrap_or_else(|| json!({})));
    }
    let start = Instant::now();
    let response = request.send().await.map_err(|error| {
        tracing::warn!(
            "[remote-mention] connection_id={} route={} elapsed_ms={} error_code=network_error",
            conn.id,
            if ALLOWED_ROUTES.contains(&command) {
                command
            } else {
                "legacy"
            },
            start.elapsed().as_millis()
        );
        network_error(error)
    })?;
    // 不记录 URL、参数、正文或错误 detail，避免认证信息和文件内容进入日志。
    tracing::info!(
        "[remote-mention] connection_id={} route={} status={} elapsed_ms={} bytes={}",
        conn.id,
        if ALLOWED_ROUTES.contains(&command) {
            command
        } else {
            "legacy"
        },
        response.status().as_u16(),
        start.elapsed().as_millis(),
        response.content_length().unwrap_or(0)
    );
    decode_response(response).await
}

fn network_error(err: reqwest::Error) -> AppCommandError {
    // 保留旧代理的网络诊断链，但去掉 URL（其中可能含用户配置的敏感路径）。
    let err = err.without_url();
    let mut detail = err.to_string();
    let mut source = std::error::Error::source(&err);
    while let Some(cause) = source {
        detail.push_str(": ");
        detail.push_str(&cause.to_string());
        source = cause.source();
    }
    AppCommandError::network("Remote HTTP request failed").with_detail(detail)
}

async fn decode_response(response: reqwest::Response) -> Result<Value, AppCommandError> {
    let status = response.status();
    if status == StatusCode::UNAUTHORIZED {
        return Err(AppCommandError::authentication_failed(
            "Remote Workspace token is invalid",
        ));
    }
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(map_error(status, &body));
    }
    response
        .json()
        .await
        .map_err(|_| AppCommandError::network("Failed to parse remote response"))
}

fn map_error(status: StatusCode, body: &str) -> AppCommandError {
    if status == StatusCode::UNAUTHORIZED {
        return AppCommandError::authentication_failed("Remote Workspace token is invalid");
    }
    if let Ok(error) = serde_json::from_str::<AppCommandError>(body) {
        return error;
    }
    if let Ok(error) = serde_json::from_str::<wire::ErrorBody>(body) {
        let code = match status.as_u16() {
            404 => AppErrorCode::NotFound,
            400 => AppErrorCode::InvalidInput,
            403 => AppErrorCode::PermissionDenied,
            409 => AppErrorCode::ConfigurationInvalid,
            _ => AppErrorCode::TaskExecutionFailed,
        };
        // 固定 AppErrorCode 不扩大枚举；detail 保留远程稳定 code 与 HTTP 状态供 broker 识别。
        return AppCommandError::new(code, error.error.message).with_detail(
            json!({"http_status": status.as_u16(), "code": error.error.code, "subtype": error.subtype}).to_string());
    }
    AppCommandError::network(format!("Remote returned HTTP {status}")).with_detail(
        if body.is_empty() {
            status.canonical_reason().unwrap_or("error").to_owned()
        } else {
            body.to_owned()
        },
    )
}

/// 仅判断配置地址，不解析 DNS；供本机连接风险提示复用。
pub fn is_public_http(raw: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(raw) else {
        return false;
    };
    if url.scheme() != "http" {
        return false;
    }
    let Some(host) = url.host_str() else {
        return false;
    };
    let host = host
        .trim_matches(['[', ']'])
        .trim_end_matches('.')
        .to_ascii_lowercase();
    if host == "localhost" || host.ends_with(".localhost") || host.ends_with(".local") {
        return false;
    }
    match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => {
            !(ip.is_loopback()
                || ip.is_private()
                || ip.is_link_local()
                || ip.is_unspecified()
                || (ip.octets()[0] == 100 && (64..=127).contains(&ip.octets()[1])))
        }
        Ok(IpAddr::V6(ip)) => {
            if let Some(v4) = ip.to_ipv4_mapped() {
                return is_public_http(&format!("http://{v4}"));
            }
            !(ip.is_loopback()
                || ip.is_unspecified()
                || (ip.segments()[0] & 0xfe00 == 0xfc00)
                || (ip.segments()[0] & 0xffc0 == 0xfe80))
        }
        Err(_) => true,
    }
}

#[cfg(test)]
mod tests;
