//! 目录扫描、完整技能包复制和受限远程解包；不跟随符号链接。
use super::*;
use std::io::{Read, Write};
use std::path::Component;
use std::time::Duration;

const DOWNLOAD_LIMIT: u64 = 32 * 1024 * 1024;
const EXPANDED_LIMIT: u64 = 128 * 1024 * 1024;
const ENTRY_LIMIT: usize = 10_000;
const MARKDOWN_LIMIT: u64 = 1024 * 1024;

fn invalid(message: &str) -> CustomSkillsError {
    CustomSkillsError::InvalidSource(message.into())
}

fn ignored(name: &std::ffi::OsStr) -> bool {
    matches!(name.to_str(), Some(".git" | ".svn" | ".hg" | ".DS_Store"))
}

fn validated_name(path: &Path) -> Result<String, CustomSkillsError> {
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_file() || metadata.len() > MARKDOWN_LIMIT {
        return Err(invalid("SKILL.md 必须是小于 1 MiB 的普通文件"));
    }
    let content = fs::read_to_string(path)?;
    let mut lines = content.lines();
    if lines.next().map(str::trim) != Some("---") {
        return Err(invalid("SKILL.md 缺少 YAML frontmatter"));
    }
    let mut yaml = String::new();
    let mut closed = false;
    for line in lines.by_ref() {
        if matches!(line.trim(), "---" | "...") {
            closed = true;
            break;
        }
        yaml.push_str(line);
        yaml.push('\n');
    }
    if !closed || !lines.any(|line| !line.trim().is_empty()) {
        return Err(invalid("SKILL.md 缺少完整 frontmatter 或正文"));
    }
    let value: serde_yaml::Value = serde_yaml::from_str(&yaml)
        .map_err(|_| invalid("SKILL.md 的 YAML frontmatter 格式无效"))?;
    let scalar = |key: &str| {
        value
            .get(key)
            .and_then(|v| v.as_str())
            .filter(|s| !s.trim().is_empty())
    };
    let name = scalar("name").ok_or_else(|| invalid("SKILL.md 缺少非空 name 字段"))?;
    scalar("description").ok_or_else(|| invalid("SKILL.md 缺少非空 description 字段"))?;
    Ok(name.trim().into())
}

fn failed(path: &Path, error: CustomSkillsError) -> CustomImportResult {
    let name = path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();
    CustomImportResult {
        id: derive_id_from_name(&name),
        name,
        ok: false,
        skipped: false,
        error: Some(error.to_string()),
    }
}

// 使用显式栈，目录深度不受调用栈或人为层数限制。
fn copy_package(src: &Path, dst: &Path) -> Result<(), CustomSkillsError> {
    let mut pending = vec![(src.to_path_buf(), dst.to_path_buf())];
    while let Some((from, to)) = pending.pop() {
        fs::create_dir_all(&to)?;
        for entry in fs::read_dir(from)? {
            let entry = entry?;
            if ignored(&entry.file_name()) {
                continue;
            }
            let kind = entry.file_type()?;
            if kind.is_symlink() {
                continue;
            }
            let target = to.join(entry.file_name());
            if kind.is_dir() {
                pending.push((entry.path(), target));
            } else if kind.is_file() {
                fs::copy(entry.path(), target)?;
            } else {
                return Err(invalid("技能包包含非普通文件"));
            }
        }
    }
    Ok(())
}

fn import_package(src: &Path, store: &Path) -> CustomImportResult {
    let name = match validated_name(&src.join("SKILL.md")) {
        Ok(name) => name,
        Err(error) => return failed(src, error),
    };
    let id = derive_id_from_name(&name);
    let mut result = CustomImportResult {
        id: id.clone(),
        name,
        ok: false,
        skipped: false,
        error: None,
    };
    if let Err(error) = validate_skill_id(&id) {
        result.error = Some(format!("技能标识无效：{error}"));
        return result;
    }
    let dst = store.join(&id);
    if fs::symlink_metadata(&dst).is_ok() {
        result.skipped = true;
        return result;
    }
    let copied = (|| {
        ensure_custom_id(&id)?;
        fs::create_dir_all(store)?;
        if fs::canonicalize(store)?.starts_with(fs::canonicalize(src)?) {
            return Err(invalid("技能源目录不能包含技能存储目录"));
        }
        let staging = tempfile::Builder::new()
            .prefix(".skill-import-")
            .tempdir_in(store)?;
        copy_package(src, &staging.path().join("package"))?;
        fs::rename(staging.path().join("package"), &dst)?;
        Ok::<_, CustomSkillsError>(())
    })();
    match copied {
        Ok(()) => result.ok = true,
        Err(error) => result.error = Some(error.to_string()),
    }
    result
}

fn scan_import(root: &Path, store: &Path) -> Result<Vec<CustomImportResult>, CustomSkillsError> {
    if !fs::symlink_metadata(root)?.is_dir() {
        return Err(invalid("请选择普通目录，不能使用符号链接"));
    }
    let mut results = Vec::new();
    let mut pending = vec![root.to_path_buf()];
    while let Some(dir) = pending.pop() {
        if fs::symlink_metadata(dir.join("SKILL.md")).is_ok() {
            results.push(import_package(&dir, store));
        }
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(error) => {
                results.push(failed(&dir, error.into()));
                continue;
            }
        };
        let mut children = Vec::new();
        for entry in entries {
            match entry.and_then(|entry| Ok((entry.file_type()?, entry))) {
                Ok((kind, entry)) if kind.is_dir() && !ignored(&entry.file_name()) => {
                    children.push(entry.path())
                }
                Ok(_) => {}
                Err(error) => results.push(failed(&dir, error.into())),
            }
        }
        children.sort();
        pending.extend(children.into_iter().rev());
    }
    tracing::info!(
        "技能批量导入完成：成功 {}，跳过 {}，失败 {}",
        results.iter().filter(|r| r.ok).count(),
        results.iter().filter(|r| r.skipped).count(),
        results.iter().filter(|r| r.error.is_some()).count()
    );
    Ok(results)
}

pub(super) async fn import_directory(
    source_path: String,
) -> Result<Vec<CustomImportResult>, CustomSkillsError> {
    let guard = mutation_lock().lock().await;
    tokio::task::spawn_blocking(move || {
        let _guard = guard;
        scan_import(Path::new(source_path.trim()), &central_experts_dir())
    })
    .await
    .map_err(|_| invalid("技能目录导入任务失败"))?
}

#[derive(Debug, PartialEq)]
enum RemoteKind {
    Zip,
    TarGz,
    Markdown,
}

struct RemoteSource {
    url: reqwest::Url,
    kind: RemoteKind,
    subdir: Option<PathBuf>,
}

fn remote_source(input: &str) -> Result<RemoteSource, CustomSkillsError> {
    let mut url = reqwest::Url::parse(input.trim()).map_err(|_| invalid("远程地址格式无效"))?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(invalid("只支持不含用户名密码的 HTTP(S) 地址"));
    }
    url.set_fragment(None);
    let path = url.path().to_string();
    if url.host_str() == Some("github.com") && !path.ends_with(".zip") && !path.ends_with(".tar.gz")
    {
        let parts: Vec<_> = path.trim_matches('/').split('/').collect();
        if parts.len() < 2
            || parts
                .iter()
                .any(|p| p.is_empty() || *p == "." || *p == ".." || p.contains('%'))
        {
            return Err(invalid(
                "GitHub 地址需要仓库所有者和仓库名，路径不能包含转义字符",
            ));
        }
        let repo = parts[1].trim_end_matches(".git");
        let base = format!("https://github.com/{}/{repo}", parts[0]);
        let (download, kind, subdir) = match parts.get(2).copied() {
            None => (format!("{base}/archive/HEAD.zip"), RemoteKind::Zip, None),
            Some("tree") if parts.len() >= 4 => (format!("{base}/archive/{}.zip", parts[3]), RemoteKind::Zip, Some(parts[4..].iter().collect())),
            Some("raw") if parts.len() >= 5 && parts.last() == Some(&"SKILL.md") => (url.to_string(), RemoteKind::Markdown, None),
            Some("blob") if parts.len() >= 5 && parts.last() == Some(&"SKILL.md") => (format!("https://raw.githubusercontent.com/{}/{repo}/{}/{}", parts[0], parts[3], parts[4..].join("/")), RemoteKind::Markdown, None),
            _ => return Err(invalid("不支持此 GitHub 地址，请使用仓库、tree/分支/目录、blob/分支/.../SKILL.md 或直接压缩包地址；分支含斜杠时请使用压缩包地址")),
        };
        let mut download =
            reqwest::Url::parse(&download).map_err(|_| invalid("GitHub 地址无效"))?;
        download.set_query(url.query());
        return Ok(RemoteSource {
            url: download,
            kind,
            subdir,
        });
    }
    let kind = if path.ends_with(".zip") {
        RemoteKind::Zip
    } else if path.ends_with(".tar.gz") || path.ends_with(".tgz") {
        RemoteKind::TarGz
    } else if path.ends_with("/SKILL.md") {
        RemoteKind::Markdown
    } else {
        return Err(invalid(
            "不支持此远程地址，请使用 GitHub 仓库/子目录、.zip、.tar.gz 或 raw SKILL.md 地址",
        ));
    };
    Ok(RemoteSource {
        url,
        kind,
        subdir: None,
    })
}

async fn download(
    source: &RemoteSource,
    target: &Path,
    limit: u64,
    timeout: Duration,
) -> Result<(), CustomSkillsError> {
    let client = reqwest::Client::builder()
        .timeout(timeout)
        .connect_timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|_| invalid("无法创建下载客户端"))?;
    // 不传播 reqwest 原始错误，避免 URL 查询参数中的凭据进入日志或界面。
    let mut response = client
        .get(source.url.clone())
        .send()
        .await
        .map_err(|_| invalid("技能下载失败或超时"))?;
    if !response.status().is_success() {
        return Err(invalid("技能下载失败：服务器返回非成功状态"));
    }
    if response.content_length().is_some_and(|size| size > limit) {
        return Err(invalid("下载文件超过大小上限（32 MiB）"));
    }
    let mut file = fs::File::create(target)?;
    let mut size = 0u64;
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| invalid("技能下载中断或超时"))?
    {
        size += chunk.len() as u64;
        if size > limit {
            return Err(invalid("下载文件超过大小上限（32 MiB）"));
        }
        file.write_all(&chunk)?;
    }
    Ok(())
}

fn safe_path(raw: &Path) -> Result<PathBuf, CustomSkillsError> {
    let text = raw.to_str().ok_or_else(|| invalid("压缩包路径编码无效"))?;
    if text.contains(['\\', ':'])
        || raw
            .components()
            .any(|c| !matches!(c, Component::Normal(_) | Component::CurDir))
        || text.is_empty()
    {
        return Err(invalid("压缩包包含不安全路径"));
    }
    Ok(raw.to_path_buf())
}

fn write_entry(
    reader: impl Read,
    path: &Path,
    remaining: &mut u64,
) -> Result<(), CustomSkillsError> {
    fs::create_dir_all(path.parent().ok_or_else(|| invalid("压缩包路径无效"))?)?;
    let mut output = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    let written = io::copy(&mut reader.take(*remaining + 1), &mut output)?;
    if written > *remaining {
        return Err(invalid("解压内容超过 128 MiB 上限"));
    }
    *remaining -= written;
    Ok(())
}

fn preserve_executable(path: &Path, mode: u32) -> Result<(), CustomSkillsError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o644 | (mode & 0o111)))?;
    }
    #[cfg(not(unix))]
    let _ = (path, mode);
    Ok(())
}

fn unpack(file: &Path, kind: &RemoteKind, root: &Path) -> Result<(), CustomSkillsError> {
    let mut remaining = EXPANDED_LIMIT;
    match kind {
        RemoteKind::Markdown => {
            fs::copy(file, root.join("SKILL.md"))?;
        }
        RemoteKind::Zip => {
            let mut archive = zip::ZipArchive::new(fs::File::open(file)?)
                .map_err(|_| invalid("ZIP 压缩包格式无效"))?;
            if archive.len() > ENTRY_LIMIT {
                return Err(invalid("压缩包条目超过 10000 项上限"));
            }
            for i in 0..archive.len() {
                let mut entry = archive.by_index(i).map_err(|_| invalid("ZIP 条目无效"))?;
                let path = safe_path(Path::new(entry.name()))?;
                let mode = entry.unix_mode().unwrap_or(0) & 0o170000;
                if mode != 0 && mode != 0o100000 && mode != 0o040000 {
                    return Err(invalid("压缩包不允许符号链接或特殊文件"));
                }
                if entry.size() > remaining {
                    return Err(invalid("解压内容超过 128 MiB 上限"));
                }
                if path.components().any(|c| ignored(c.as_os_str())) {
                    continue;
                }
                if entry.is_dir() {
                    fs::create_dir_all(root.join(path))?;
                } else {
                    write_entry(&mut entry, &root.join(&path), &mut remaining)?;
                    preserve_executable(&root.join(path), entry.unix_mode().unwrap_or(0))?;
                }
            }
        }
        RemoteKind::TarGz => {
            // 限制解码后的 tar 字节流，连同填充、扩展头一起计入，防止空条目/头部压缩炸弹。
            let decoder = flate2::read::GzDecoder::new(fs::File::open(file)?);
            let mut archive = tar::Archive::new(decoder.take(EXPANDED_LIMIT + 1));
            for (i, entry) in archive.entries()?.enumerate() {
                if i >= ENTRY_LIMIT {
                    return Err(invalid("压缩包条目超过 10000 项上限"));
                }
                let mut entry = entry?;
                let path = safe_path(&entry.path()?)?;
                let kind = entry.header().entry_type();
                if !kind.is_file() && !kind.is_dir() {
                    return Err(invalid("压缩包不允许链接或特殊文件"));
                }
                if entry.size() > remaining {
                    return Err(invalid("解压内容超过 128 MiB 上限"));
                }
                if path.components().any(|c| ignored(c.as_os_str())) {
                    continue;
                }
                if kind.is_dir() {
                    fs::create_dir_all(root.join(path))?;
                } else {
                    write_entry(&mut entry, &root.join(&path), &mut remaining)?;
                    preserve_executable(&root.join(path), entry.header().mode()?)?;
                }
            }
            let mut decoded = archive.into_inner();
            io::copy(&mut decoded, &mut io::sink())?;
            if decoded.limit() == 0 {
                return Err(invalid("解压内容超过 128 MiB 上限"));
            }
        }
    }
    Ok(())
}

// 嵌套技能包会重复复制子包内容，远程导入前也限制实际复制总量。
fn validate_copy_budget(root: &Path) -> Result<(), CustomSkillsError> {
    let mut pending = vec![(root.to_path_buf(), 0usize)];
    let mut bytes = 0u64;
    let mut entries = 0usize;
    while let Some((dir, parents)) = pending.pop() {
        let copies = parents + usize::from(dir.join("SKILL.md").is_file());
        entries = entries.saturating_add(copies);
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            if ignored(&entry.file_name()) {
                continue;
            }
            let kind = entry.file_type()?;
            if kind.is_dir() {
                pending.push((entry.path(), copies));
            } else if kind.is_file() {
                entries = entries.saturating_add(copies);
                bytes = bytes.saturating_add(entry.metadata()?.len().saturating_mul(copies as u64));
            } else {
                return Err(invalid("远程技能包不允许链接或特殊文件"));
            }
        }
        if bytes > EXPANDED_LIMIT || entries > ENTRY_LIMIT {
            return Err(invalid("嵌套技能包的总复制量超过 128 MiB 或 10000 项上限"));
        }
    }
    Ok(())
}

pub(super) async fn import_remote(
    url: String,
) -> Result<Vec<CustomImportResult>, CustomSkillsError> {
    let source = remote_source(&url)?;
    let temp = tempfile::Builder::new()
        .prefix("codeg-skill-import-")
        .tempdir()?;
    let prepared = prepare_remote(source, temp).await?;
    let guard = mutation_lock().lock().await;
    tokio::task::spawn_blocking(move || {
        let _guard = guard;
        let _temp = prepared.0;
        scan_import(&prepared.1, &central_experts_dir())
    })
    .await
    .map_err(|_| invalid("远程技能导入任务失败"))?
}

async fn prepare_remote(
    source: RemoteSource,
    temp: tempfile::TempDir,
) -> Result<(tempfile::TempDir, PathBuf), CustomSkillsError> {
    let archive = temp.path().join("download");
    download(&source, &archive, DOWNLOAD_LIMIT, Duration::from_secs(45)).await?;
    let root = temp.path().join("unpacked");
    fs::create_dir(&root)?;
    tokio::task::spawn_blocking(move || {
        unpack(&archive, &source.kind, &root)?;
        let scan_root = if let Some(subdir) = source.subdir {
            let mut entries = fs::read_dir(&root)?;
            let first = entries.next().ok_or_else(|| invalid("仓库压缩包为空"))??;
            if entries.next().is_some() || !first.file_type()?.is_dir() {
                return Err(invalid("仓库压缩包结构无效"));
            }
            first.path().join(subdir)
        } else {
            root
        };
        if !scan_root.is_dir() {
            return Err(invalid(
                "仓库子目录不存在，请检查分支和目录；分支含斜杠时请使用直接压缩包地址",
            ));
        }
        validate_copy_budget(&scan_root)?;
        Ok::<_, CustomSkillsError>((temp, scan_root))
    })
    .await
    .map_err(|_| invalid("技能解包任务失败"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::thread;

    const VALID: &str = "---\nname: deep-skill\ndescription: 测试技能\n---\n# 正文\n";

    fn package(root: &Path, name: &str) {
        fs::create_dir_all(root.join("scripts")).unwrap();
        fs::write(root.join("SKILL.md"), VALID.replace("deep-skill", name)).unwrap();
        fs::write(root.join("scripts/run.sh"), "echo 测试").unwrap();
    }

    #[test]
    fn recursive_multi_package_duplicate_invalid_and_empty() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("source");
        let store = temp.path().join("store");
        let deep = root.join("a/b/c/d/e/f/g/h/i/j/k");
        package(&deep, "deep-skill");
        package(&root.join("other"), "other-skill");
        package(&root.join("duplicate"), "deep-skill");
        package(&root.join(".git/hidden"), "hidden-skill");
        fs::create_dir(root.join("invalid")).unwrap();
        fs::write(root.join("invalid/SKILL.md"), "# 普通 Markdown").unwrap();
        let results = scan_import(&root, &store).unwrap();
        assert_eq!(results.len(), 4);
        assert_eq!(results.iter().filter(|r| r.ok).count(), 2);
        assert_eq!(results.iter().filter(|r| r.skipped).count(), 1);
        assert_eq!(results.iter().filter(|r| r.error.is_some()).count(), 1);
        assert_eq!(
            fs::read_to_string(store.join("deep-skill/scripts/run.sh")).unwrap(),
            "echo 测试"
        );
        fs::write(store.join("deep-skill/SKILL.md"), "保留已有内容").unwrap();
        assert_eq!(
            scan_import(&root, &store)
                .unwrap()
                .iter()
                .filter(|r| r.skipped)
                .count(),
            3
        );
        assert_eq!(
            fs::read_to_string(store.join("deep-skill/SKILL.md")).unwrap(),
            "保留已有内容"
        );
        let empty = temp.path().join("empty");
        fs::create_dir(&empty).unwrap();
        assert!(scan_import(&empty, &store).unwrap().is_empty());
    }

    #[test]
    fn validates_frontmatter_and_rejects_contained_store() {
        let temp = tempfile::tempdir().unwrap();
        for content in [
            "---\nname: x\n---\n正文",
            "---\nname: [x]\ndescription: d\n---\n正文",
            "---\nname: x\ndescription: d\n---\n",
            "---\nname: [\ndescription: d\n---\n正文",
        ] {
            fs::write(temp.path().join("SKILL.md"), content).unwrap();
            assert!(validated_name(&temp.path().join("SKILL.md")).is_err());
        }
        package(temp.path(), "中文名称");
        let store = tempfile::tempdir().unwrap();
        let invalid_id = import_package(temp.path(), store.path());
        assert!(invalid_id.error.is_some() && !invalid_id.skipped);
        package(temp.path(), "contained");
        assert!(import_package(temp.path(), &temp.path().join("store"))
            .error
            .is_some());
    }

    #[cfg(unix)]
    #[test]
    fn never_scans_or_copies_symlinks() {
        use std::os::unix::fs::symlink;
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("source");
        package(&root.join("real"), "real");
        symlink(&root, root.join("loop")).unwrap();
        symlink("/etc/passwd", root.join("real/secret")).unwrap();
        symlink(root.join("real/SKILL.md"), root.join("SKILL.md")).unwrap();
        let store = temp.path().join("store");
        let results = scan_import(&root, &store).unwrap();
        assert_eq!(results.len(), 2);
        assert_eq!(results.iter().filter(|r| r.ok).count(), 1);
        assert!(!store.join("real/secret").exists());
    }

    fn zip_bytes(name: &str, content: &[u8], symlink: bool) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(io::Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated);
        if symlink {
            writer.add_symlink(name, "target", options).unwrap();
        } else {
            writer.start_file(name, options).unwrap();
            writer.write_all(content).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }

    #[test]
    fn zip_rejects_traversal_links_and_bombs() {
        let temp = tempfile::tempdir().unwrap();
        let archive = temp.path().join("archive");
        let root = temp.path().join("unpacked");
        fs::create_dir(&root).unwrap();
        for name in ["../escape", "/absolute", "C:/windows", "x\\..\\escape"] {
            fs::write(&archive, zip_bytes(name, b"bad", false)).unwrap();
            assert!(unpack(&archive, &RemoteKind::Zip, &root).is_err());
        }
        fs::write(&archive, zip_bytes("link", b"", true)).unwrap();
        assert!(unpack(&archive, &RemoteKind::Zip, &root).is_err());
        let mut writer = zip::ZipWriter::new(fs::File::create(&archive).unwrap());
        writer
            .start_file(
                "bomb",
                zip::write::SimpleFileOptions::default()
                    .compression_method(zip::CompressionMethod::Deflated),
            )
            .unwrap();
        let block = [0u8; 1024 * 1024];
        for _ in 0..129 {
            writer.write_all(&block).unwrap();
        }
        writer.finish().unwrap();
        assert!(unpack(&archive, &RemoteKind::Zip, &root).is_err());
        assert!(!root.join("bomb").exists());
        let mut writer = zip::ZipWriter::new(fs::File::create(&archive).unwrap());
        for i in 0..=ENTRY_LIMIT {
            writer
                .add_directory(
                    format!("entry-{i}/"),
                    zip::write::SimpleFileOptions::default(),
                )
                .unwrap();
        }
        writer.finish().unwrap();
        assert!(unpack(&archive, &RemoteKind::Zip, &root).is_err());
        let mut remaining = 3;
        assert!(write_entry(
            io::Cursor::new(b"1234"),
            &root.join("limited"),
            &mut remaining
        )
        .is_err());
    }

    fn tar_bytes(link: bool) -> Vec<u8> {
        let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        let mut builder = tar::Builder::new(encoder);
        let mut header = tar::Header::new_gnu();
        header.set_mode(0o644);
        if link {
            header.set_entry_type(tar::EntryType::Symlink);
            header.set_size(0);
            header.set_link_name("../../outside").unwrap();
            header.set_cksum();
            builder
                .append_data(&mut header, "link", io::empty())
                .unwrap();
        } else {
            header.set_size(VALID.len() as u64);
            header.set_cksum();
            builder
                .append_data(&mut header, "package/SKILL.md", VALID.as_bytes())
                .unwrap();
        }
        builder.into_inner().unwrap().finish().unwrap()
    }

    #[test]
    fn tar_gz_imports_package_and_rejects_links_and_truncation() {
        let temp = tempfile::tempdir().unwrap();
        let archive = temp.path().join("archive");
        let root = temp.path().join("unpacked");
        fs::create_dir(&root).unwrap();
        fs::write(&archive, tar_bytes(false)).unwrap();
        unpack(&archive, &RemoteKind::TarGz, &root).unwrap();
        assert_eq!(
            validated_name(&root.join("package/SKILL.md")).unwrap(),
            "deep-skill"
        );
        fs::write(&archive, tar_bytes(true)).unwrap();
        assert!(unpack(&archive, &RemoteKind::TarGz, &root).is_err());
        fs::write(&archive, b"not gzip").unwrap();
        assert!(unpack(&archive, &RemoteKind::TarGz, &root).is_err());
        let mut encoder = flate2::write::GzEncoder::new(
            fs::File::create(&archive).unwrap(),
            flate2::Compression::fast(),
        );
        let block = [0u8; 1024 * 1024];
        for _ in 0..129 {
            encoder.write_all(&block).unwrap();
        }
        encoder.finish().unwrap();
        assert!(unpack(&archive, &RemoteKind::TarGz, &root).is_err());
    }

    #[test]
    fn recognizes_supported_urls_and_rejects_unsupported_addresses() {
        let repo = remote_source("https://github.com/owner/repo").unwrap();
        assert_eq!(repo.url.path(), "/owner/repo/archive/HEAD.zip");
        let tree = remote_source("https://github.com/owner/repo/tree/main/skills/example").unwrap();
        assert_eq!(tree.subdir.unwrap(), PathBuf::from("skills/example"));
        assert_eq!(
            remote_source("https://github.com/owner/repo/blob/main/skill/SKILL.md")
                .unwrap()
                .kind,
            RemoteKind::Markdown
        );
        for url in [
            "https://example.test/p.zip",
            "http://example.test/p.tar.gz",
            "https://github.com/o/r/raw/refs/heads/main/SKILL.md",
            "https://raw.githubusercontent.com/o/r/main/SKILL.md",
        ] {
            assert!(remote_source(url).is_ok());
        }
        for url in [
            "file:///tmp/a.zip",
            "ftp://a/p.zip",
            "https://u:secret@example.test/a.zip",
            "https://example.test/readme.md",
            "https://github.com/o/r/issues/1",
        ] {
            assert!(remote_source(url).is_err());
        }
    }

    // 本机 HTTP mock，不访问外网；返回句柄便于确保服务结束。
    fn mock_http(
        body: Vec<u8>,
        headers: &str,
        delay: Duration,
    ) -> (String, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let headers = headers.to_owned();
        let worker = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0; 2048];
            let _ = stream.read(&mut request);
            thread::sleep(delay);
            let _ = write!(
                stream,
                "HTTP/1.1 200 OK\r\nConnection: close\r\n{headers}\r\n"
            );
            let _ = stream.write_all(&body);
        });
        (
            format!("http://{address}/package.zip?token=不可泄露"),
            worker,
        )
    }

    #[test]
    fn nested_packages_cannot_amplify_remote_copy_size_or_entry_count() {
        let temp = tempfile::tempdir().unwrap();
        package(temp.path(), "outer");
        let nested = temp.path().join("nested");
        package(&nested, "inner");
        validate_copy_budget(temp.path()).unwrap();
        let asset = fs::File::create(nested.join("asset")).unwrap();
        asset.set_len(EXPANDED_LIMIT / 2).unwrap();
        assert!(validate_copy_budget(temp.path()).is_err());
        asset.set_len(0).unwrap();
        for i in 0..ENTRY_LIMIT / 2 {
            fs::write(nested.join(format!("empty-{i}")), []).unwrap();
        }
        assert!(validate_copy_budget(temp.path()).is_err());
    }

    #[tokio::test]
    async fn remote_pipeline_cleans_up_on_success_and_unpack_failure() {
        let parent = tempfile::tempdir().unwrap();
        for (body, kind, success) in [
            (
                zip_bytes("repo/skills/SKILL.md", VALID.as_bytes(), false),
                RemoteKind::Zip,
                true,
            ),
            (tar_bytes(false), RemoteKind::TarGz, true),
            (VALID.as_bytes().to_vec(), RemoteKind::Markdown, true),
            (
                zip_bytes("../escape", b"bad", false),
                RemoteKind::Zip,
                false,
            ),
        ] {
            let (url, worker) = mock_http(
                body.clone(),
                &format!("Content-Length: {}\r\n", body.len()),
                Duration::ZERO,
            );
            let mut source = remote_source(&url).unwrap();
            source.kind = kind;
            if source.kind == RemoteKind::Zip && success {
                source.subdir = Some(PathBuf::from("skills"));
            }
            let temp = tempfile::tempdir_in(parent.path()).unwrap();
            let temp_path = temp.path().to_path_buf();
            let prepared = prepare_remote(source, temp).await;
            assert_eq!(prepared.is_ok(), success);
            if let Ok((temp, root)) = prepared {
                let results = scan_import(&root, &parent.path().join("store")).unwrap();
                assert_eq!(results.len(), 1);
                assert!(results.iter().all(|r| r.ok || r.skipped));
                drop(temp);
            }
            assert!(!temp_path.exists());
            worker.join().unwrap();
        }
    }

    #[tokio::test]
    async fn local_http_download_unpack_limits_timeout_and_cleanup() {
        let parent = tempfile::tempdir().unwrap();
        let body = zip_bytes("package/SKILL.md", VALID.as_bytes(), false);
        let (url, worker) = mock_http(
            body.clone(),
            &format!("Content-Length: {}\r\n", body.len()),
            Duration::ZERO,
        );
        let temp = tempfile::tempdir_in(parent.path()).unwrap();
        let archive = temp.path().join("download");
        download(
            &remote_source(&url).unwrap(),
            &archive,
            DOWNLOAD_LIMIT,
            Duration::from_secs(2),
        )
        .await
        .unwrap();
        worker.join().unwrap();
        let unpacked = temp.path().join("unpacked");
        fs::create_dir(&unpacked).unwrap();
        unpack(&archive, &RemoteKind::Zip, &unpacked).unwrap();
        assert!(scan_import(&unpacked, &parent.path().join("store")).unwrap()[0].ok);
        let temp_path = temp.path().to_path_buf();
        drop(temp);
        assert!(!temp_path.exists());
        for headers in ["Content-Length: 999\r\n", ""] {
            let (url, worker) = mock_http(vec![0; 20], headers, Duration::ZERO);
            let temp = tempfile::tempdir_in(parent.path()).unwrap();
            let result = download(
                &remote_source(&url).unwrap(),
                &temp.path().join("download"),
                10,
                Duration::from_secs(2),
            )
            .await;
            assert!(result.is_err());
            assert!(!result.unwrap_err().to_string().contains("token"));
            worker.join().unwrap();
            let temp_path = temp.path().to_path_buf();
            drop(temp);
            assert!(!temp_path.exists());
        }
        let (url, worker) = mock_http(vec![], "", Duration::from_millis(100));
        let error = download(
            &remote_source(&url).unwrap(),
            &parent.path().join("timeout"),
            10,
            Duration::from_millis(20),
        )
        .await
        .unwrap_err();
        assert!(!error.to_string().contains("token"));
        worker.join().unwrap();
    }
}
