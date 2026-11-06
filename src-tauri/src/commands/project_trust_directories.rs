//! 项目信任选择器的只读目录枚举，不创建目录，也不写入信任决定。
use std::path::Path;

use crate::app_error::AppCommandError;
use crate::commands::folders::DirectoryEntry;

#[cfg(windows)]
fn roots() -> std::io::Result<Vec<DirectoryEntry>> {
    // 系统盘符位图包含已挂载的本地盘及网络盘，不逐个探测不存在的盘符。
    let mask = unsafe { windows_sys::Win32::Storage::FileSystem::GetLogicalDrives() };
    if mask == 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok((0..26)
        .filter(|bit| mask & (1 << bit) != 0)
        .map(|bit| {
            let path = format!("{}:\\", char::from(b'A' + bit));
            DirectoryEntry {
                name: path.clone(),
                path,
                has_children: true,
            }
        })
        .collect())
}

#[cfg(not(windows))]
fn roots() -> std::io::Result<Vec<DirectoryEntry>> {
    Ok(vec![DirectoryEntry {
        name: "/".into(),
        path: "/".into(),
        has_children: true,
    }])
}

fn entries(path: Option<&str>) -> Result<Vec<DirectoryEntry>, AppCommandError> {
    let Some(path) = path else {
        return roots().map_err(|e| {
            AppCommandError::io_error("无法列出文件系统根目录").with_detail(e.to_string())
        });
    };
    let root = Path::new(path);
    if !root.is_absolute() || !root.is_dir() {
        return Err(AppCommandError::invalid_input("请选择现存目录的绝对路径"));
    }
    let read = std::fs::read_dir(root)
        .map_err(|e| AppCommandError::io_error("无法读取目录").with_detail(e.to_string()))?;
    let mut children = Vec::new();
    for item in read {
        let item = item.map_err(|e| {
            AppCommandError::io_error("无法读取目录条目").with_detail(e.to_string())
        })?;
        // 只列目录；隐藏目录保留。链接目录可选，授权时另行显示规范路径。
        if item.file_name() == ".DS_Store" || !item.path().is_dir() {
            continue;
        }
        children.push(DirectoryEntry {
            name: item.file_name().to_string_lossy().into_owned(),
            path: item.path().to_string_lossy().into_owned(),
            // 不预读所有孩子，避免根目录扫描慢盘/网络盘；展开时再读取一级。
            // 空目录展开得到空列表，仍然可以勾选目录本身。
            has_children: true,
        });
    }
    children.sort_by_key(|entry| entry.name.to_lowercase());
    Ok(children)
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn project_trust_directories(
    path: Option<String>,
) -> Result<Vec<DirectoryEntry>, AppCommandError> {
    tokio::task::spawn_blocking(move || entries(path.as_deref()))
        .await
        .map_err(|e| AppCommandError::io_error("目录枚举任务失败").with_detail(e.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_hidden_directories_without_files_or_recursion() {
        let temp = tempfile::tempdir().unwrap();
        for name in ["visible", ".hidden", ".DS_Store"] {
            std::fs::create_dir(temp.path().join(name)).unwrap();
        }
        std::fs::create_dir(temp.path().join(".hidden/nested")).unwrap();
        std::fs::write(temp.path().join("file.txt"), "not a directory").unwrap();
        let result = entries(temp.path().to_str()).unwrap();
        assert_eq!(
            result
                .iter()
                .map(|item| item.name.as_str())
                .collect::<Vec<_>>(),
            vec![".hidden", "visible"]
        );
        assert!(result
            .iter()
            .all(|item| Path::new(&item.path).is_absolute()));
        assert_eq!(
            entries(temp.path().join(".hidden").to_str()).unwrap()[0].name,
            "nested"
        );
    }

    #[test]
    fn rejects_relative_missing_and_file_paths() {
        assert!(entries(Some(".")).is_err());
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("file");
        std::fs::write(&file, "file").unwrap();
        assert!(entries(file.to_str()).is_err());
        assert!(entries(temp.path().join("missing").to_str()).is_err());
    }

    #[test]
    fn lists_native_absolute_roots() {
        let roots = entries(None).unwrap();
        assert!(!roots.is_empty());
        assert!(roots
            .iter()
            .all(|entry| Path::new(&entry.path).is_absolute()));
        #[cfg(not(windows))]
        assert_eq!(roots[0].path, "/");
    }
}
