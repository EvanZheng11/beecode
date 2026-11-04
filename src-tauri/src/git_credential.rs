use std::path::{Path, PathBuf};

use sea_orm::DatabaseConnection;

use crate::db::service::app_metadata_service;
use crate::models::system::{GitHubAccount, GitHubAccountsSettings};

const GITHUB_ACCOUNTS_KEY: &str = "github_accounts";

/// Wrap a value as a POSIX-sh single-quoted literal so it survives shell
/// evaluation regardless of which characters it contains. Internal `'`
/// is closed, escaped, and reopened (`'\''`). Used both inside the
/// generated helper script and inside `GIT_CONFIG_VALUE_0` (which git
/// hands to `sh -c`).
pub(crate) fn sh_single_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for ch in s.chars() {
        if ch == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(ch);
        }
    }
    out.push('\'');
    out
}

/// Wrap a value as a Windows-batch double-quoted literal. Inside batch
/// files, `%VAR%` is expanded even within double quotes, so we must
/// escape `%` to `%%` (which the batch parser rewrites back to a literal
/// `%`). Internal `"` is doubled to `""` so the value can't terminate the
/// quoted string. Compiled on Windows (where it's used by the helper
/// script generator) and under `cfg(test)` (so tests can exercise the
/// escape rules from any host).
#[cfg(any(windows, test))]
pub(crate) fn bat_double_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\"\""),
            '%' => out.push_str("%%"),
            other => out.push(other),
        }
    }
    out.push('"');
    out
}

/// Make a path absolute without requiring it to exist on disk. Falls back
/// to the original path if the current directory is unreadable.
pub fn absolutize(p: &Path) -> PathBuf {
    if p.is_absolute() {
        return p.to_path_buf();
    }
    std::env::current_dir()
        .map(|cwd| cwd.join(p))
        .unwrap_or_else(|_| p.to_path_buf())
}

/// Create a credential helper that calls the app binary directly with
/// `--credential-helper` flag. The app binary opens the DB, looks up
/// the matching account, and outputs credentials to stdout.
///
/// The script embeds the absolute `--data-dir` path so that server-mode
/// deployments (which don't share the desktop's Tauri identifier-derived
/// data dir) point the helper at the correct database. `run_credential_helper`
/// falls back to a hardcoded resolution if the flag is missing for back-compat
/// with stale scripts on disk.
///
/// Paths are absolutized and shell-quoted before being substituted into the
/// script body so a quirky data dir (`CODEG_DATA_DIR=$HOME/x`, paths with
/// spaces, single quotes, or `"`) cannot break — or escape — the script.
pub fn create_credential_helper_script(
    app_data_dir: &Path,
    app_binary_path: &Path,
) -> std::io::Result<PathBuf> {
    let app_data_dir = absolutize(app_data_dir);
    let app_binary_path = absolutize(app_binary_path);
    let binary_str = app_binary_path.to_string_lossy();
    let data_dir_str = app_data_dir.to_string_lossy();

    #[cfg(unix)]
    {
        let script_path = app_data_dir.join("git-credential-codeg.sh");
        let content = format!(
            r#"#!/bin/sh
# Codeg credential helper — calls the app binary to look up credentials.
# Only responds to "get" action; ignores "store" and "erase".
[ "$1" != "get" ] && exit 0
exec {binary} --credential-helper --data-dir {data_dir} < /dev/stdin
"#,
            binary = sh_single_quote(&binary_str),
            data_dir = sh_single_quote(&data_dir_str),
        );
        std::fs::write(&script_path, content)?;
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&script_path, std::fs::Permissions::from_mode(0o755))?;
        Ok(script_path)
    }

    #[cfg(windows)]
    {
        let script_path = app_data_dir.join("git-credential-codeg.bat");
        let content = format!(
            r#"@echo off
if not "%~1"=="get" exit /b 0
{binary} --credential-helper --data-dir {data_dir}
"#,
            binary = bat_double_quote(&binary_str),
            data_dir = bat_double_quote(&data_dir_str),
        );
        std::fs::write(&script_path, content)?;
        Ok(script_path)
    }
}

/// Run the credential helper mode (called from main when `--credential-helper` is detected).
///
/// Reads git's credential protocol from stdin (host=xxx, protocol=xxx),
/// opens the DB, finds the matching account, and outputs username/password
/// to stdout. Exits immediately — does NOT start the Tauri GUI.
pub fn run_credential_helper() {
    // Parse the optional `--data-dir <path>` arg. Helper scripts written by
    // recent codeg versions embed this so server deployments and custom
    // CODEG_DATA_DIR setups land on the right database.
    let explicit_data_dir = parse_data_dir_arg(std::env::args());

    // Pin CODEG_DATA_DIR for downstream lookups (notably the file-based
    // `keyring_store::tokens_file_path` in server mode). The DB path comes
    // from `--data-dir`, but the token file path comes from the env var,
    // and they must match — otherwise the helper finds the account row but
    // returns no token. set_var is safe here because run_credential_helper
    // is invoked from main() before any tokio runtime is built.
    if let Some(dir) = &explicit_data_dir {
        std::env::set_var("CODEG_DATA_DIR", dir);
    }

    // git's credential protocol expects this helper to be silent on a
    // miss so the caller (and any subsequent helper in the chain) can
    // proceed cleanly. `Ok(None)` outcomes — empty stdin, missing DB,
    // unmatched host, no token — return without writing to stderr; only
    // genuine errors (DB connection failure, runtime build failure) are
    // surfaced. This avoids polluting the agent's terminal output and
    // leaking the local data-dir path on every GitLab/enterprise URL.
    let Some((protocol, host)) = read_credential_request() else {
        return;
    };

    // Prefer the path passed by the helper script; only fall back to the
    // hardcoded Tauri-style location for stale scripts written before the
    // `--data-dir` flag existed.
    let app_data_dir = match explicit_data_dir.or_else(resolve_app_data_dir) {
        Some(d) => d,
        None => return,
    };

    // Use a minimal tokio runtime just for the DB query
    let rt = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            tracing::error!("[codeg credential-helper] tokio runtime build failed: {e}");
            return;
        }
    };

    match rt.block_on(lookup_credential(&app_data_dir, &protocol, &host)) {
        Ok(Some((username, token))) => {
            println!("username={username}");
            println!("password={token}");
        }
        Ok(None) => {
            // Silent — git falls through to the next helper. See block
            // comment above for why we don't log here.
        }
        Err(e) => tracing::error!("[codeg credential-helper] lookup failed: {e}"),
    }
}

/// 读取 Git credential 协议，不响应 HTTP(S) 之外的请求。
fn read_credential_request() -> Option<(String, String)> {
    use std::io::BufRead;
    let mut host = String::new();
    let mut protocol = String::new();
    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        if line.is_empty() {
            break;
        }
        if let Some(value) = line.strip_prefix("host=") {
            host = value.to_string();
        }
        if let Some(value) = line.strip_prefix("protocol=") {
            protocol = value.to_string();
        }
    }
    if !host.is_empty() && matches!(protocol.as_str(), "http" | "https") {
        Some((protocol, host))
    } else {
        None
    }
}

/// Look up a (username, token) pair for the given host using the codeg
/// database in `app_data_dir` plus whichever token store is active for this
/// build (OS keyring on desktop, `tokens.json` on server).
///
/// Returns:
///   - `Ok(Some((u, p)))` when a matching account + token are found.
///   - `Ok(None)` for normal misses — DB doesn't exist yet, no GitHub
///     accounts configured, no account matches `host`, token absent
///     from the store. All miss paths are silent so the helper doesn't
///     pollute agent/terminal output or leak the local data-dir path
///     when the user hits an unconfigured GitLab/enterprise host.
///   - `Err(_)` for I/O / DB / driver errors that the caller should
///     surface verbatim.
///
/// Extracted from `run_credential_helper` so tests can exercise the
/// lookup path without spawning a subprocess.
pub(crate) async fn lookup_credential(
    app_data_dir: &Path,
    protocol: &str,
    host: &str,
) -> Result<Option<(String, String)>, String> {
    let db_path = app_data_dir.join(crate::db::database_file_name());
    if !db_path.exists() {
        return Ok(None);
    }

    let db_url = format!(
        "sqlite:{}?mode=ro",
        urlencoding::encode(&db_path.to_string_lossy())
    );
    let mut opts = sea_orm::ConnectOptions::new(db_url);
    // Match every other `ConnectOptions` in the tree: sqlx logs each statement,
    // with its SQL text, at INFO. Here that lands on the helper's **stderr**,
    // which git splices into the agent's / terminal's output — the one thing the
    // contract above ("all miss paths are silent") exists to prevent.
    opts.sqlx_logging(false);
    let conn = sea_orm::Database::connect(opts)
        .await
        .map_err(|e| format!("open db: {e}"))?;

    let settings = match load_github_accounts(&conn).await {
        Some(s) => s,
        None => return Ok(None),
    };

    // host 是 Git 协议的 authority，不能包含 userinfo、路径或查询。
    if !matches!(protocol, "http" | "https")
        || host.is_empty()
        || host.contains(['/', '@', '?', '#', '\\', '\r', '\n'])
    {
        return Ok(None);
    }
    let remote_url = format!("{protocol}://{host}");
    let account = match find_matching_account(&settings.accounts, &remote_url) {
        Some(a) => a,
        None => return Ok(None),
    };

    let username = git_username_for(account);
    match crate::keyring_store::get_token(&account.id) {
        Some(token)
            if !token.is_empty()
                && !token.contains(['\r', '\n'])
                && !username.contains(['\r', '\n']) =>
        {
            Ok(Some((username.to_string(), token)))
        }
        _ => Ok(None),
    }
}

/// Extract `--data-dir <path>` (or `--data-dir=<path>`) from the given args,
/// or `None` if absent. Generic over any String iterator so tests can
/// supply a vec without touching the real process args.
fn parse_data_dir_arg<I: IntoIterator<Item = String>>(args: I) -> Option<std::path::PathBuf> {
    let mut iter = args.into_iter();
    while let Some(arg) = iter.next() {
        if arg == "--data-dir" {
            return iter.next().map(std::path::PathBuf::from);
        }
        if let Some(value) = arg.strip_prefix("--data-dir=") {
            return Some(std::path::PathBuf::from(value));
        }
    }
    None
}

/// Resolve the app data directory (same path Tauri uses).
fn resolve_app_data_dir() -> Option<std::path::PathBuf> {
    // On macOS: ~/Library/Application Support/app.codeg
    // On Linux: ~/.local/share/app.codeg
    // On Windows: %APPDATA%/app.codeg
    #[cfg(target_os = "macos")]
    {
        dirs::data_dir().map(|d| d.join("app.codeg"))
    }
    #[cfg(target_os = "linux")]
    {
        dirs::data_dir().map(|d| d.join("app.codeg"))
    }
    #[cfg(target_os = "windows")]
    {
        dirs::data_dir().map(|d| d.join("app.codeg"))
    }
}

/// Ensure the GIT_ASKPASS helper script exists in the app data directory.
/// Returns the path to the script.
pub fn ensure_askpass_script(app_data_dir: &Path) -> std::io::Result<PathBuf> {
    #[cfg(unix)]
    {
        let script_path = app_data_dir.join("git-askpass.sh");
        if !script_path.exists() {
            let content = r#"#!/bin/sh
case "$1" in
*[Uu]sername*) echo "$CODEG_GIT_USERNAME" ;;
*[Pp]assword*) echo "$CODEG_GIT_PASSWORD" ;;
esac
"#;
            std::fs::write(&script_path, content)?;
            // Make executable
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&script_path, std::fs::Permissions::from_mode(0o755))?;
        }
        Ok(script_path)
    }

    #[cfg(windows)]
    {
        let script_path = app_data_dir.join("git-askpass.bat");
        if !script_path.exists() {
            let content = r#"@echo off
echo %1 | findstr /i "username" >nul
if %errorlevel% equ 0 (
    echo %CODEG_GIT_USERNAME%
    exit /b
)
echo %1 | findstr /i "password" >nul
if %errorlevel% equ 0 (
    echo %CODEG_GIT_PASSWORD%
    exit /b
)
"#;
            std::fs::write(&script_path, content)?;
        }
        Ok(script_path)
    }
}

/// Inject GitHub credentials into a git command via GIT_ASKPASS.
pub fn inject_credentials(
    cmd: &mut tokio::process::Command,
    username: &str,
    token: &str,
    askpass_path: &Path,
) {
    // Clear all system credential helpers (e.g. macOS Keychain `osxkeychain`)
    // so git falls through to GIT_ASKPASS. Without this, a system credential
    // helper may return stale/wrong credentials and GIT_ASKPASS is never called.
    // Per git docs, setting credential.helper="" resets the helper list.
    cmd.env("GIT_CONFIG_COUNT", "1")
        .env("GIT_CONFIG_KEY_0", "credential.helper")
        .env("GIT_CONFIG_VALUE_0", "")
        .env("GIT_ASKPASS", askpass_path)
        .env("CODEG_GIT_USERNAME", username)
        .env("CODEG_GIT_PASSWORD", token)
        .env("GIT_TERMINAL_PROMPT", "0");
}

/// The username git should send for a stored account.
///
/// Usually the account's own login. CNB is the exception: its git server
/// takes a FIXED username, `cnb`, with the access token as the password, and
/// documents that value as the only one to send — the account's login is not
/// a username it authenticates by.
pub fn git_username_for(account: &GitHubAccount) -> &str {
    let is_cnb = account
        .provider
        .as_deref()
        .is_some_and(|p| p.trim().eq_ignore_ascii_case("cnb"));
    if is_cnb {
        CNB_GIT_USERNAME
    } else {
        &account.username
    }
}

/// See [`git_username_for`].
pub const CNB_GIT_USERNAME: &str = "cnb";

/// Get the remote URL for the "origin" remote of a repository.
pub async fn get_remote_url(repo_path: &str) -> Option<String> {
    get_remote_url_by_name(repo_path, "origin").await
}

/// Get the remote URL for a specific named remote.
pub async fn get_remote_url_by_name(repo_path: &str, remote_name: &str) -> Option<String> {
    let output = crate::process::tokio_command("git")
        .args(["remote", "get-url", remote_name])
        .current_dir(repo_path)
        .output()
        .await
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let url = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if url.is_empty() {
        None
    } else {
        Some(url)
    }
}

/// Extract the hostname from a git remote URL.
///
/// Handles both HTTPS and SSH URLs:
/// - `https://github.com/user/repo.git` → `github.com`
/// - `git@github.com:user/repo.git` → `github.com`
fn extract_host(remote_url: &str) -> Option<String> {
    let url = remote_url.trim();

    // 使用标准 URL 解析器，只从 authority 提取 host，保留非默认端口。
    if let Ok(parsed) = url::Url::parse(url) {
        if matches!(parsed.scheme(), "http" | "https") {
            let host = parsed.host()?.to_string().to_lowercase();
            return Some(match parsed.port() {
                Some(port) => format!("{host}:{port}"),
                None => host,
            });
        }
    }

    // SSH: git@github.com:user/repo.git
    if let Some(at_pos) = url.find('@') {
        let after_at = &url[at_pos + 1..];
        return after_at.split(':').next().map(|h| h.to_lowercase());
    }

    None
}

/// Find the best matching account for a given remote URL.
///
/// Only returns an account whose server_url hostname matches the remote URL host.
/// When multiple accounts match the same hostname, prefers the one marked `is_default`.
/// Does NOT fall back to unrelated accounts — if no hostname matches, returns None
/// so the caller can fall back to git config defaults.
pub fn find_matching_account<'a>(
    accounts: &'a [GitHubAccount],
    remote_url: &str,
) -> Option<&'a GitHubAccount> {
    if accounts.is_empty() {
        return None;
    }

    let remote_host = extract_host(remote_url)?;

    let matching: Vec<&GitHubAccount> = accounts
        .iter()
        .filter(|a| {
            let account_host = extract_host(&a.server_url)
                .unwrap_or_else(|| a.server_url.trim().trim_end_matches('/').to_lowercase());
            account_host == remote_host
        })
        .collect();

    // Prefer the default account among matches, otherwise take the first
    matching
        .iter()
        .find(|a| a.is_default)
        .or(matching.first())
        .copied()
}

/// Load GitHub accounts from the database.
pub async fn load_github_accounts(conn: &DatabaseConnection) -> Option<GitHubAccountsSettings> {
    let raw = app_metadata_service::get_value(conn, GITHUB_ACCOUNTS_KEY)
        .await
        .ok()??;

    serde_json::from_str::<GitHubAccountsSettings>(&raw).ok()
}

/// Resolve the commit author (name + email) from the matching account for a repo.
///
/// Returns `Some((name, email))` if a matching account is found.
/// Uses GitHub's noreply email format: `username@users.noreply.github.com`.
pub async fn resolve_commit_author(
    repo_path: &str,
    conn: &DatabaseConnection,
) -> Option<(String, String)> {
    let settings = load_github_accounts(conn).await?;
    if settings.accounts.is_empty() {
        return None;
    }

    let remote_url = get_remote_url(repo_path).await?;
    let account = find_matching_account(&settings.accounts, &remote_url)?;

    let host = extract_host(&remote_url).unwrap_or_default();
    let email = if host == "github.com" {
        format!("{}@users.noreply.github.com", account.username)
    } else {
        // For non-GitHub hosts, use username@host as a reasonable fallback
        format!("{}@{}", account.username, host)
    };

    Some((account.username.clone(), email))
}

/// 配置按 Git 实际请求 host 查询账号的 helper，适用于 upstream、pushurl 和 fetch --all。
/// token 不写入脚本，也不依赖本地化的 askpass 提示。
pub fn inject_stored_accounts(cmd: &mut tokio::process::Command, app_data_dir: &Path) -> bool {
    let Some(env) = crate::commands::terminal::prepare_credential_env(app_data_dir) else {
        return false;
    };
    let Some(helper) = env.get("GIT_CONFIG_VALUE_0") else {
        return false;
    };
    inject_credential_helper(cmd, helper);
    true
}

fn inject_credential_helper(cmd: &mut tokio::process::Command, helper: &str) {
    // 清空旧 helper，禁止 askpass 回退和 HTTP 重定向，避免跨 host 发送凭据。
    cmd.env("GIT_CONFIG_COUNT", "3")
        .env("GIT_CONFIG_KEY_0", "credential.helper")
        .env("GIT_CONFIG_VALUE_0", "")
        .env("GIT_CONFIG_KEY_1", "credential.helper")
        .env("GIT_CONFIG_VALUE_1", helper)
        .env("GIT_CONFIG_KEY_2", "http.followRedirects")
        .env("GIT_CONFIG_VALUE_2", "false")
        .env("GIT_ASKPASS", "false")
        .env("SSH_ASKPASS", "false")
        .env("GIT_TERMINAL_PROMPT", "0");
}

/// 显式输入的凭据仅响应指定 URL 的协议与 authority，store/erase 不持久化。
pub fn inject_credentials_for_url(
    cmd: &mut tokio::process::Command,
    remote_url: &str,
    username: &str,
    token: &str,
) {
    let Ok(url) = url::Url::parse(remote_url) else {
        return;
    };
    if !matches!(url.scheme(), "http" | "https") {
        return;
    }
    let Some(_) = extract_host(remote_url) else {
        return;
    };
    if username.contains(['\r', '\n']) || token.contains(['\r', '\n']) {
        return;
    }
    // Git 的 host 字段保留显式默认端口，不能使用 URL 解析器归一化后的 authority。
    let Some((_, address)) = remote_url.split_once("://") else {
        return;
    };
    let authority = address
        .split(['/', '?', '#'])
        .next()
        .unwrap()
        .rsplit('@')
        .next()
        .unwrap();
    let helper = r#"!f() {
[ "$1" = get ] || exit 0
protocol= host=
while IFS= read -r line && [ -n "$line" ]; do
  case "$line" in protocol=*) protocol=${line#protocol=} ;; host=*) host=${line#host=} ;; esac
done
[ "$protocol" = "$CODEG_GIT_PROTOCOL" ] && [ "$host" = "$CODEG_GIT_HOST" ] || exit 0
printf 'username=%s\npassword=%s\n' "$CODEG_GIT_USERNAME" "$CODEG_GIT_PASSWORD"
}; f"#;
    inject_credential_helper(cmd, helper);
    cmd.env("CODEG_GIT_PROTOCOL", url.scheme())
        .env("CODEG_GIT_HOST", authority)
        .env("CODEG_GIT_USERNAME", username)
        .env("CODEG_GIT_PASSWORD", token);
}

/// Git 请求凭据时才匹配账号，不提前假定 origin 或 fetch URL。
/// 返回 true 表示已配置 helper，实际账号/token 是否可用由请求时决定。
pub async fn try_inject_for_repo(
    cmd: &mut tokio::process::Command,
    repo_path: &str,
    conn: &DatabaseConnection,
    app_data_dir: &Path,
) -> bool {
    try_inject_for_repo_remote(cmd, repo_path, None, conn, app_data_dir).await
}

/// 保留 remote 参数以兼容现有调用；凭据按 Git 实际请求匹配。
pub async fn try_inject_for_repo_remote(
    cmd: &mut tokio::process::Command,
    repo_path: &str,
    remote_name: Option<&str>,
    conn: &DatabaseConnection,
    app_data_dir: &Path,
) -> bool {
    let _ = (repo_path, remote_name);
    match load_github_accounts(conn).await {
        Some(settings) if !settings.accounts.is_empty() => {
            inject_stored_accounts(cmd, app_data_dir)
        }
        _ => false,
    }
}

/// Clone 同样按 Git 实际请求的 host 查询账号。
pub async fn try_inject_for_url(
    cmd: &mut tokio::process::Command,
    clone_url: &str,
    conn: &DatabaseConnection,
    app_data_dir: &Path,
) -> bool {
    if !clone_url.starts_with("https://") && !clone_url.starts_with("http://") {
        return false;
    }
    try_inject_for_repo_remote(cmd, "", None, conn, app_data_dir).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scoped_credentials_reject_noncanonical_url_and_protocol_newlines() {
        for (url, username, token) in [
            ("http:git.example/repo", "user", "fake-token"),
            (
                "https://git.example/repo",
                "user\npassword=bad",
                "fake-token",
            ),
            ("https://git.example/repo", "user", "fake-token\n"),
        ] {
            let mut cmd = tokio::process::Command::new("git");
            inject_credentials_for_url(&mut cmd, url, username, token);
            assert!(!cmd
                .as_std()
                .get_envs()
                .any(|(key, _)| key == "CODEG_GIT_PASSWORD"));
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn scoped_credentials_only_answer_matching_authority() {
        use tokio::io::AsyncWriteExt;
        let tmp = tempfile::tempdir().unwrap();
        for (protocol, host, expected) in [
            ("https", "git.example:8443", true),
            ("https", "other.example:8443", false),
            ("https", "git.example", false),
            ("http", "git.example:8443", false),
        ] {
            let mut cmd = tokio::process::Command::new("git");
            cmd.env_clear()
                .env("PATH", std::env::var_os("PATH").unwrap())
                .env("HOME", tmp.path())
                .env("GIT_CONFIG_NOSYSTEM", "1")
                .env("GIT_CONFIG_GLOBAL", "/dev/null")
                .env("LC_ALL", "zh_CN.UTF-8")
                .current_dir(tmp.path())
                .args(["credential", "fill"])
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped());
            inject_credentials_for_url(
                &mut cmd,
                "https://git.example:8443/repo",
                "test-user",
                "fake-$'token",
            );
            let mut child = cmd.spawn().unwrap();
            child
                .stdin
                .take()
                .unwrap()
                .write_all(format!("protocol={protocol}\nhost={host}\n\n").as_bytes())
                .await
                .unwrap();
            let output = child.wait_with_output().await.unwrap();
            assert_eq!(output.status.success(), expected, "{protocol} {host}");
            let stdout = String::from_utf8(output.stdout).unwrap();
            assert_eq!(stdout.contains("password=fake-$'token"), expected);
            assert!(!String::from_utf8_lossy(&output.stderr).contains("fake-$'token"));
        }
        assert!(!tmp.path().join(".git-credentials").exists());
    }

    #[test]
    fn test_extract_host_does_not_treat_path_as_authority() {
        assert_eq!(
            extract_host("https://other.example/repo@github.com/org"),
            Some("other.example".into())
        );
        assert_eq!(
            extract_host("https://github.com:8443/org"),
            Some("github.com:8443".into())
        );
        assert_eq!(
            extract_host("https://github.com:443/org"),
            Some("github.com".into())
        );
    }

    #[test]
    fn test_extract_host_https() {
        assert_eq!(
            extract_host("https://github.com/user/repo.git"),
            Some("github.com".to_string())
        );
        assert_eq!(
            extract_host("https://user@github.com/user/repo.git"),
            Some("github.com".to_string())
        );
        assert_eq!(
            extract_host("https://gitlab.example.com/org/repo"),
            Some("gitlab.example.com".to_string())
        );
    }

    #[test]
    fn test_extract_host_ssh() {
        assert_eq!(
            extract_host("git@github.com:user/repo.git"),
            Some("github.com".to_string())
        );
    }

    #[test]
    fn a_cnb_account_sends_the_fixed_git_username() {
        let account = |provider: Option<&str>| GitHubAccount {
            id: "1".into(),
            server_url: "https://cnb.cool".into(),
            username: "alice".into(),
            scopes: vec![],
            avatar_url: None,
            is_default: true,
            created_at: String::new(),
            provider: provider.map(str::to_string),
        };
        assert_eq!(git_username_for(&account(Some("cnb"))), "cnb");
        // Every other forge authenticates by the account's own login.
        assert_eq!(git_username_for(&account(Some("gitea"))), "alice");
        assert_eq!(git_username_for(&account(None)), "alice");
    }

    #[test]
    fn test_find_matching_account() {
        let accounts = vec![
            GitHubAccount {
                id: "1".into(),
                server_url: "https://github.com".into(),
                username: "user1".into(),
                scopes: vec![],
                avatar_url: None,
                is_default: false,
                created_at: String::new(),
                provider: None,
            },
            GitHubAccount {
                id: "2".into(),
                server_url: "https://gitlab.example.com".into(),
                username: "user2".into(),
                scopes: vec![],
                avatar_url: None,
                is_default: true,
                created_at: String::new(),
                provider: None,
            },
        ];

        let matched = find_matching_account(&accounts, "https://github.com/org/repo.git");
        assert_eq!(matched.unwrap().username, "user1");

        let matched = find_matching_account(&accounts, "https://gitlab.example.com/org/repo");
        assert_eq!(matched.unwrap().username, "user2");

        // Unknown host returns None — no fallback to unrelated accounts
        let matched = find_matching_account(&accounts, "https://unknown.com/repo");
        assert!(matched.is_none());
    }

    #[test]
    fn test_find_matching_account_prefers_default() {
        let accounts = vec![
            GitHubAccount {
                id: "1".into(),
                server_url: "https://github.com".into(),
                username: "personal".into(),
                scopes: vec![],
                avatar_url: None,
                is_default: false,
                created_at: String::new(),
                provider: None,
            },
            GitHubAccount {
                id: "2".into(),
                server_url: "https://github.com".into(),
                username: "work".into(),
                scopes: vec![],
                avatar_url: None,
                is_default: true,
                created_at: String::new(),
                provider: None,
            },
        ];

        // Should pick the default account when multiple match the same host
        let matched = find_matching_account(&accounts, "https://github.com/org/repo.git");
        assert_eq!(matched.unwrap().username, "work");
    }

    #[test]
    fn test_parse_data_dir_arg_space_separated() {
        let args = vec![
            "codeg".to_string(),
            "--credential-helper".to_string(),
            "--data-dir".to_string(),
            "/tmp/codeg-data".to_string(),
        ];
        assert_eq!(
            parse_data_dir_arg(args),
            Some(std::path::PathBuf::from("/tmp/codeg-data"))
        );
    }

    #[test]
    fn test_parse_data_dir_arg_equals_form() {
        let args = vec![
            "codeg".to_string(),
            "--data-dir=/tmp/codeg-data".to_string(),
            "--credential-helper".to_string(),
        ];
        assert_eq!(
            parse_data_dir_arg(args),
            Some(std::path::PathBuf::from("/tmp/codeg-data"))
        );
    }

    #[test]
    fn test_parse_data_dir_arg_absent() {
        let args = vec!["codeg".to_string(), "--credential-helper".to_string()];
        assert_eq!(parse_data_dir_arg(args), None);
    }

    #[test]
    fn test_parse_data_dir_arg_missing_value_treated_as_absent() {
        // `--data-dir` at the very end with no following token: do not crash.
        let args = vec!["codeg".to_string(), "--data-dir".to_string()];
        assert_eq!(parse_data_dir_arg(args), None);
    }

    #[cfg(unix)]
    #[test]
    fn test_helper_script_embeds_data_dir() {
        let tmp = std::env::temp_dir().join(format!("codeg-cred-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp).expect("create tmp dir");
        let binary = std::path::PathBuf::from("/usr/local/bin/codeg-server");

        let script_path = create_credential_helper_script(&tmp, &binary)
            .expect("script generation should succeed");
        let content = std::fs::read_to_string(&script_path).expect("read script");

        // Must invoke the embedded binary with both flags so server-mode
        // deployments don't fall back to the hardcoded `app.codeg` path.
        // Paths are sh-single-quoted so spaces / `$` / backticks survive.
        assert!(content.contains("/usr/local/bin/codeg-server"));
        assert!(content.contains("--credential-helper"));
        assert!(
            content.contains(&format!("--data-dir '{}'", tmp.display())),
            "script should embed sh-quoted --data-dir; got:\n{content}"
        );

        // Sanity: the script must be executable, otherwise git's exec fails
        // silently and we'd never reach the helper at all.
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&script_path)
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o111, 0o111, "script should be executable");

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_sh_single_quote_basic() {
        assert_eq!(sh_single_quote("plain"), "'plain'");
        assert_eq!(sh_single_quote("with space"), "'with space'");
        assert_eq!(sh_single_quote(""), "''");
    }

    #[test]
    fn test_sh_single_quote_special_chars_inert() {
        // Inside single quotes sh treats `$`, backtick, `\`, `"` as literal,
        // so no extra escaping needed beyond the wrap.
        assert_eq!(sh_single_quote("$HOME"), "'$HOME'");
        assert_eq!(sh_single_quote("`whoami`"), "'`whoami`'");
        assert_eq!(sh_single_quote(r#"with"quote"#), r#"'with"quote'"#);
        assert_eq!(sh_single_quote(r"back\slash"), r"'back\slash'");
    }

    #[test]
    fn test_sh_single_quote_internal_apostrophe() {
        // The one character that needs escaping: a literal `'` ends the
        // quoted segment; we close, escape with `\'`, and reopen.
        assert_eq!(sh_single_quote("a'b"), "'a'\\''b'");
        assert_eq!(sh_single_quote("'leading"), "''\\''leading'");
        assert_eq!(sh_single_quote("trailing'"), "'trailing'\\'''");
    }

    // `std::env::set_current_dir` and `std::env::set_var` are both
    // process-global; parallel tests that either mutate or read them must
    // serialize via this mutex to avoid flakes (e.g. `current_dir()` /
    // `var()` returning whatever the racing test happened to set).
    // `lock().unwrap_or_else(PoisonError::into_inner)` keeps a panic in
    // one test from poisoning every later case.
    static STATE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    #[test]
    fn test_absolutize_already_absolute() {
        let abs = std::env::current_dir().expect("cwd");
        assert_eq!(absolutize(&abs), abs);
    }

    #[test]
    fn test_absolutize_relative_joins_cwd() {
        let _guard = STATE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let cwd = std::env::current_dir().expect("cwd");
        let rel = std::path::PathBuf::from("relative/path");
        assert_eq!(absolutize(&rel), cwd.join("relative/path"));
    }

    #[cfg(unix)]
    #[test]
    fn test_helper_script_absolutizes_relative_data_dir() {
        // Regression: a relative `CODEG_DATA_DIR=data` previously produced
        // a script that git couldn't find when invoked from the user's
        // repo working dir. The script must always reference an absolute
        // path so it resolves identically regardless of git's CWD.
        let _guard = STATE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let unique = format!("codeg-rel-test-{}", uuid::Uuid::new_v4());
        let tmp_root = std::env::temp_dir().join(&unique);
        std::fs::create_dir_all(&tmp_root).expect("create tmp root");
        let prev_cwd = std::env::current_dir().expect("cwd");
        std::env::set_current_dir(&tmp_root).expect("chdir");

        let rel = std::path::PathBuf::from("data");
        std::fs::create_dir_all(&rel).expect("create rel dir");
        let binary = std::path::PathBuf::from("./codeg-server");

        let script_path = create_credential_helper_script(&rel, &binary)
            .expect("script generation should succeed");

        assert!(
            script_path.is_absolute(),
            "returned script path must be absolute"
        );
        let content = std::fs::read_to_string(&script_path).expect("read script");

        // The invariant we care about: neither the binary nor the data-dir
        // appears in the script as a bare relative segment. Anything quoted
        // in the script must start with `/` so git resolves it the same
        // regardless of which repo it's invoked from.
        assert!(
            !content.contains("'data'"),
            "relative data-dir leaked into script:\n{content}"
        );
        assert!(
            !content.contains("'./codeg-server'"),
            "relative binary path leaked into script:\n{content}"
        );
        // Positive check: an absolute path segment for the data dir must be
        // present (its filename is `data`, prefixed by some absolute path).
        assert!(
            content.contains("--data-dir '/"),
            "data-dir is not embedded as an absolute path:\n{content}"
        );
        assert!(
            content.contains("exec '/"),
            "binary is not embedded as an absolute path:\n{content}"
        );

        std::env::set_current_dir(&prev_cwd).expect("restore cwd");
        let _ = std::fs::remove_dir_all(&tmp_root);
    }

    #[test]
    fn test_bat_double_quote_basic() {
        assert_eq!(bat_double_quote("plain"), "\"plain\"");
        assert_eq!(bat_double_quote("with space"), "\"with space\"");
        assert_eq!(bat_double_quote(""), "\"\"");
    }

    #[test]
    fn test_bat_double_quote_escapes_quote() {
        // A literal `"` inside a batch double-quoted string would close
        // it; doubling lets us embed one without breaking out.
        assert_eq!(bat_double_quote(r#"a"b"#), r#""a""b""#);
    }

    #[test]
    fn test_bat_double_quote_escapes_percent() {
        // Inside a .bat file, `%FOO%` expands even within `"..."`. The
        // batch parser collapses `%%` to a literal `%`, so doubling the
        // sign is enough to disable expansion of any `%word%` segments
        // that happen to be present in a path.
        assert_eq!(bat_double_quote("%FOO%"), "\"%%FOO%%\"");
        assert_eq!(
            bat_double_quote(r"C:\Users\%USERNAME%\codeg"),
            "\"C:\\Users\\%%USERNAME%%\\codeg\""
        );
    }

    #[cfg(unix)]
    #[test]
    fn test_helper_script_escapes_apostrophe_in_path() {
        // Regression: a path with a `'` previously closed the sh quoted
        // string and could allow command substitution. With proper escaping
        // the literal apostrophe survives as data, never as syntax.
        let tmp = std::env::temp_dir().join(format!("codeg-apos-test-{}", uuid::Uuid::new_v4()));
        let with_apos = tmp.join("o'brien");
        std::fs::create_dir_all(&with_apos).expect("create tmp dir");
        let binary = std::path::PathBuf::from("/bin/echo");

        let script_path = create_credential_helper_script(&with_apos, &binary)
            .expect("script generation should succeed");
        let content = std::fs::read_to_string(&script_path).expect("read script");

        // The path is split into two single-quoted segments around the `'`,
        // joined by `\'` — this is the standard sh-quote-an-apostrophe trick.
        // We check for the embedded sequence, not the full path, because the
        // surrounding tmp-root prefix varies per run.
        assert!(
            content.contains(r"o'\''brien"),
            "expected sh-quoted apostrophe sequence; got:\n{content}"
        );
        // Sanity: the old broken form (double-quoted, with the apostrophe
        // sitting raw inside the quotes) must not appear.
        assert!(
            !content.contains("\"o'brien\""),
            "double-quoted form leaked through:\n{content}"
        );

        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// End-to-end check of the server-mode credential helper lookup path.
    /// Sets up a real on-disk SQLite DB, seeds a GitHub account row, writes
    /// a token to the file-based store, then exercises `lookup_credential`
    /// the same way `run_credential_helper` does. Compiled only in
    /// server-mode builds (`cargo test --no-default-features`) because the
    /// Tauri-mode token store hits the OS keyring, which we can't safely
    /// mutate from a test.
    #[cfg(all(unix, not(feature = "tauri-runtime")))]
    #[test]
    fn test_credential_helper_e2e_server_mode() {
        let _guard = STATE_LOCK.lock().unwrap_or_else(|e| e.into_inner());

        let data_dir =
            std::env::temp_dir().join(format!("codeg-helper-e2e-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&data_dir).expect("create data dir");

        let username = "octocat";
        let token = "ghp_test_token_value";
        let account_id = "acct-1";

        // Override CODEG_DATA_DIR for the duration of this test — server-mode
        // `keyring_store` resolves `tokens.json` from this var.
        //
        // Through `temp_env`, NOT a bare `set_var` + manual restore. `STATE_LOCK`
        // is private to this module, so it serializes this test against its two
        // neighbours here and against nothing else; `forge::auth`'s
        // `resolution_prefers_pinned_id_then_default_and_redacts_debug` guards the
        // same variable with `temp_env::async_with_vars` and never learns of it.
        // `keyring_store::tokens_file_path` re-reads the variable on every call
        // and caches nothing, so with two locks that don't know about each other,
        // one test's `set_token` writes under this data dir while the other's
        // reader looks under its own — surfacing as `no stored token for account
        // …` on whichever side loses. Both `temp_env` entry points take the one
        // `SERIAL_TEST` mutex, so routing through it is what actually makes the
        // two mutually exclusive.
        //
        // Order is always STATE_LOCK then SERIAL_TEST: nothing holding
        // SERIAL_TEST can reach STATE_LOCK, so the pair can't invert.
        temp_env::with_vars([("CODEG_DATA_DIR", Some(&data_dir))], || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("tokio rt");

            rt.block_on(async {
                // Seed: real on-disk DB with migrations + one github_accounts entry.
                let db = crate::db::init_database(&data_dir, "test")
                    .await
                    .expect("init db");

                let settings = GitHubAccountsSettings {
                    accounts: vec![GitHubAccount {
                        id: account_id.into(),
                        server_url: "https://github.com".into(),
                        username: username.into(),
                        scopes: vec![],
                        avatar_url: None,
                        is_default: true,
                        created_at: String::new(),
                        provider: None,
                    }],
                };
                let json = serde_json::to_string(&settings).expect("serialize settings");
                crate::db::service::app_metadata_service::upsert_value(
                    &db.conn,
                    GITHUB_ACCOUNTS_KEY,
                    &json,
                )
                .await
                .expect("seed accounts");

                // Drop the writer connection so the read-only re-open inside
                // `lookup_credential` doesn't race against an open WAL writer.
                drop(db);

                // Seed the file token store. Uses CODEG_DATA_DIR via
                // `tokens_file_path`, which is exactly what we're validating.
                crate::keyring_store::set_token(account_id, token).expect("set token");

                // Lookup must round-trip the seeded credentials. Pass an absolute
                // data_dir to mirror the production helper invocation.
                let result = lookup_credential(&data_dir, "https", "github.com")
                    .await
                    .expect("lookup should not error");
                assert_eq!(
                    result,
                    Some((username.to_string(), token.to_string())),
                    "lookup_credential should resolve seeded github.com account"
                );

                // Negative case: an unseeded host must return Ok(None), never
                // fall back to a default account or a hard error.
                let miss = lookup_credential(&data_dir, "https", "gitlab.example.com")
                    .await
                    .expect("miss should be Ok(None), not Err");
                assert!(miss.is_none(), "unrelated host must not match");
            });
        });

        let _ = std::fs::remove_dir_all(&data_dir);
    }
}
