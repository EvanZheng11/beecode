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

// 祖先关系无法区分“已合并”和“刚创建”。只接受仍属于当前历史的本分支提交记录。
// 创建、merge/rebase 等更新及缺失/过期的 reflog 都不足以证明曾有独立提交。
fn has_committed_work(path: &str, branch: &str, head: &str) -> bool {
    let branch_ref = format!("refs/heads/{branch}");
    let Some(log) = git(path, &["reflog", "show", "--format=%H%x00%gs", &branch_ref]) else {
        return false;
    };
    let Ok(log) = String::from_utf8(log) else {
        return false;
    };
    log.lines().any(|line| {
        let Some((commit, action)) = line.split_once('\0') else {
            return false;
        };
        // std_command 固定英文 locale；只白名单普通提交及 amend，其他 action 不作为提交证据。
        (action.starts_with("commit: ") || action.starts_with("commit (amend): "))
            && git(path, &["merge-base", "--is-ancestor", commit, head]).is_some()
    })
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
        if !has_committed_work(path, branch, head.trim()) {
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
        run(&["config", "user.name", "Test"]);
        run(&["config", "user.email", "test@example.invalid"]);
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
        let fresh = root.join("fresh");
        let rebased = root.join("rebased");
        for (dir, branch) in [
            (&merged, "merged"),
            (&dirty, "dirty"),
            (&pending, "pending"),
            (&fresh, "task/new"),
            (&rebased, "rebased"),
        ] {
            run(&["worktree", "add", "-b", branch, dir.to_str().unwrap()]);
        }
        run(&["worktree", "add", "--detach", detached.to_str().unwrap()]);
        // 新分支与 main 同 HEAD，随后 main 前进，两种情况都必须保留。
        assert!(list(repo).is_empty());
        run(&["commit", "--allow-empty", "-m", "main advances"]);
        assert!(list(repo).is_empty());
        // 只有 merge/rebase 更新，没有本分支 commit，也不能隐藏。
        assert!(git(fresh.to_str().unwrap(), &["merge", "--ff-only", "main"]).is_some());
        assert!(git(rebased.to_str().unwrap(), &["rebase", "main"]).is_some());
        assert!(list(repo).is_empty());
        // 真实提交并合入 main 后才隐藏，提交说明使用中文。
        fs::write(merged.join("merged-file"), "work").unwrap();
        assert!(git(merged.to_str().unwrap(), &["add", "merged-file"]).is_some());
        assert!(git(merged.to_str().unwrap(), &["commit", "-m", "独立工作"]).is_some());
        assert!(git(
            merged.to_str().unwrap(),
            &["commit", "--amend", "-m", "独立工作修订"]
        )
        .is_some());
        assert!(list(repo).is_empty());
        run(&["merge", "--no-ff", "merged", "-m", "merge work"]);
        assert_eq!(list(repo), vec![merged.to_str().unwrap().to_string()]);
        let log = git(
            repo,
            &["reflog", "show", "--format=%gs", "refs/heads/merged"],
        )
        .unwrap();
        assert!(String::from_utf8(log)
            .unwrap()
            .lines()
            .any(|s| s == "commit: 独立工作"));
        // merge 自身产生提交、rebase 跟随主线，都不冒充本分支 commit 操作。
        assert!(git(
            fresh.to_str().unwrap(),
            &["merge", "--no-ff", "main", "-m", "merge only"]
        )
        .is_some());
        run(&["merge", "--ff-only", "task/new"]);
        assert!(git(rebased.to_str().unwrap(), &["rebase", "main"]).is_some());
        assert!(!list(repo).contains(&fresh.to_str().unwrap().to_string()));
        assert!(!list(repo).contains(&rebased.to_str().unwrap().to_string()));
        // 从已有工作分支创建的新分支不能继承其“做过工作”的证据。
        let copied = root.join("copied");
        run(&[
            "worktree",
            "add",
            "-b",
            "copied",
            copied.to_str().unwrap(),
            "merged",
        ]);
        assert!(!list(repo).contains(&copied.to_str().unwrap().to_string()));
        // 旧提交若已 reset 丢弃，不能作为当前分支已完成工作的依据。
        let reset = root.join("reset");
        run(&["worktree", "add", "-b", "reset", reset.to_str().unwrap()]);
        assert!(git(
            reset.to_str().unwrap(),
            &["commit", "--allow-empty", "-m", "discarded"]
        )
        .is_some());
        assert!(git(reset.to_str().unwrap(), &["reset", "--hard", "main"]).is_some());
        assert!(!list(repo).contains(&reset.to_str().unwrap().to_string()));
        // dirty 自己也有已合入的提交，确保保留确实来自脏状态保护。
        assert!(git(
            dirty.to_str().unwrap(),
            &["commit", "--allow-empty", "-m", "dirty work"]
        )
        .is_some());
        run(&["merge", "--no-ff", "dirty", "-m", "merge dirty work"]);
        assert!(list(repo).contains(&dirty.to_str().unwrap().to_string()));
        fs::write(dirty.join("untracked"), "work").unwrap();
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
        assert_eq!(list(repo), vec![merged.to_str().unwrap().to_string()]);
        // 从附属 worktree 查询也不得把主目录或 detached HEAD 当成可隐藏对象。
        assert_eq!(list(pending.to_str().unwrap()), list(repo));
        run(&["merge", "--no-ff", "pending", "-m", "merge pending"]);
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
        run(&["merge", "--no-ff", "pending", "-m", "merge tracked"]);
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
        // reflog 过期及文件缺失均视为未知；不从提交图猜测分支工作来源。
        run(&["reflog", "expire", "--expire=all", "refs/heads/merged"]);
        assert!(!list(repo).contains(&merged.to_str().unwrap().to_string()));
        let log_path = git(repo, &["rev-parse", "--git-path", "logs/refs/heads/merged"]).unwrap();
        let log_path = String::from_utf8(log_path).unwrap();
        fs::remove_file(Path::new(repo).join(log_path.trim())).unwrap();
        assert!(!list(repo).contains(&merged.to_str().unwrap().to_string()));
        assert!(list(root.to_str().unwrap()).is_empty());
        fs::remove_dir_all(root).unwrap();
    }
}
