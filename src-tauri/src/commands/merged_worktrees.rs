use std::path::Path;

// 只读取本地 Git。任何失败都按未知处理，调用方不得据此隐藏目录。
fn git(path: &str, args: &[&str]) -> Option<Vec<u8>> {
    let output = crate::process::std_command("git")
        .args(args)
        .current_dir(path)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .output()
        .ok()?;
    output.status.success().then_some(output.stdout)
}

pub(super) fn list(path: &str) -> Vec<String> {
    let (output, separator, terminator) =
        if let Some(output) = git(path, &["worktree", "list", "--porcelain", "-z"]) {
            (output, "\0\0", '\0')
        } else if let Some(output) = git(path, &["worktree", "list", "--porcelain"]) {
            // 旧 Git 不支持 -z；转义过的特殊路径保持未知，不猜测真实目录。
            (output, "\n\n", '\n')
        } else {
            return vec![];
        };
    // -z 保留空格、换行和非 ASCII 路径，避免把 Git 转义路径当成真实目录。
    let Ok(output) = String::from_utf8(output) else {
        return vec![];
    };
    let entries: Vec<_> = output
        .split(separator)
        .filter_map(|block| {
            let mut fields = block.split(terminator);
            let path = fields.next()?.strip_prefix("worktree ")?;
            if terminator == '\n' && path.starts_with('"') {
                return Some((path, None));
            }
            let branch = fields.find_map(|f| f.strip_prefix("branch refs/heads/"));
            Some((path, branch))
        })
        .collect();
    let Some((_, Some(main_branch))) = entries.first() else {
        return vec![];
    };
    // 主工作树可能临时切到功能分支；仅使用明确的默认分支或 main/master。
    let default = git(
        path,
        &["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
    )
    .and_then(|bytes| String::from_utf8(bytes).ok())
    .and_then(|s| {
        s.trim()
            .strip_prefix("refs/remotes/origin/")
            .map(str::to_owned)
    });
    let target = default.as_deref().unwrap_or(main_branch);
    if default.is_none() && !matches!(target, "main" | "master") {
        return vec![];
    }
    let target_ref = format!("refs/heads/{target}");
    let Some(target_tip) = git(path, &["rev-parse", "--verify", &target_ref]) else {
        return vec![];
    };
    let target_tip = String::from_utf8_lossy(&target_tip);
    let mut merged = Vec::new();
    for (worktree, branch) in entries.iter().skip(1) {
        let Some(branch) = branch else { continue };
        if matches!(*branch, "main" | "master") || *branch == target || branch == main_branch {
            continue;
        }
        if !Path::new(worktree).is_dir() {
            continue;
        }
        let Some(head) = git(worktree, &["rev-parse", "--verify", "HEAD"]) else {
            continue;
        };
        let head = String::from_utf8_lossy(&head);
        if git(
            path,
            &[
                "merge-base",
                "--is-ancestor",
                head.trim(),
                target_tip.trim(),
            ],
        )
        .is_none()
        {
            continue;
        }
        // 已提交内容合入后仍可能有未保存工作，包含暂存、未跟踪文件及子模块变更。
        if git(
            worktree,
            &[
                "status",
                "--porcelain",
                "--untracked-files=normal",
                "--ignore-submodules=none",
            ],
        )
        .is_some_and(|status| status.is_empty())
        {
            merged.push((*worktree).to_owned());
        }
    }
    merged
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT: AtomicU64 = AtomicU64::new(0);

    #[test]
    fn only_clean_merged_secondary_worktrees_are_hidden() {
        let root = std::env::temp_dir().join(format!(
            "codeg-merged-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).unwrap();
        let repo = root.join("repo");
        fs::create_dir(&repo).unwrap();
        let repo = repo.to_str().unwrap();
        let run = |args: &[&str]| assert!(git(repo, args).is_some(), "{args:?}");
        run(&["init", "-b", "main"]);
        run(&[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.invalid",
            "commit",
            "--allow-empty",
            "-m",
            "base",
        ]);
        let merged = root.join("已合并 worktree");
        let dirty = root.join("dirty");
        let pending = root.join("pending");
        let detached = root.join("detached");
        for (dir, branch) in [
            (&merged, "merged"),
            (&dirty, "dirty"),
            (&pending, "pending"),
        ] {
            run(&["worktree", "add", "-b", branch, dir.to_str().unwrap()]);
        }
        run(&["worktree", "add", "--detach", detached.to_str().unwrap()]);
        assert!(git(
            pending.to_str().unwrap(),
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.invalid",
                "commit",
                "--allow-empty",
                "-m",
                "pending"
            ]
        )
        .is_some());
        fs::write(dirty.join("untracked"), "work").unwrap();
        assert_eq!(list(repo), vec![merged.to_str().unwrap().to_string()]);
        // 从附属 worktree 查询也不得把主目录或 detached HEAD 当成可隐藏对象。
        assert_eq!(list(pending.to_str().unwrap()), list(repo));
        run(&["merge", "--ff-only", "pending"]);
        assert!(list(repo).contains(&pending.to_str().unwrap().to_string()));
        // 暂存与未暂存修改也必须保留目录。
        fs::write(pending.join("tracked"), "base").unwrap();
        assert!(git(pending.to_str().unwrap(), &["add", "tracked"]).is_some());
        assert!(!list(repo).contains(&pending.to_str().unwrap().to_string()));
        assert!(git(pending.to_str().unwrap(), &["reset", "--hard", "HEAD"]).is_some());
        fs::write(pending.join("tracked"), "base").unwrap();
        assert!(git(pending.to_str().unwrap(), &["add", "tracked"]).is_some());
        assert!(git(
            pending.to_str().unwrap(),
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.invalid",
                "commit",
                "-m",
                "tracked"
            ]
        )
        .is_some());
        run(&["merge", "--ff-only", "pending"]);
        fs::write(pending.join("tracked"), "changed").unwrap();
        assert!(!list(repo).contains(&pending.to_str().unwrap().to_string()));
        let master = root.join("master");
        run(&["worktree", "add", "-b", "master", master.to_str().unwrap()]);
        assert!(!list(repo).contains(&master.to_str().unwrap().to_string()));
        run(&["checkout", "-b", "unknown-default"]);
        assert!(list(repo).is_empty());
        run(&["update-ref", "refs/remotes/origin/main", "refs/heads/main"]);
        run(&[
            "symbolic-ref",
            "refs/remotes/origin/HEAD",
            "refs/remotes/origin/main",
        ]);
        assert!(list(repo).contains(&merged.to_str().unwrap().to_string()));
        assert!(!list(repo).contains(&master.to_str().unwrap().to_string()));
        assert!(list(root.to_str().unwrap()).is_empty());
        fs::remove_dir_all(root).unwrap();
    }
}
