use std::path::PathBuf;

#[cfg(feature = "tauri-runtime")]
use super::opened_paths::retry_delay;
use super::opened_paths::{
    deduplicate_paths, event_for_path, parse_opened_url, EnqueueResult, FinderDirectoryOpened,
    OpenedPathError, OpenedPathQueue,
};

#[test]
fn parses_and_canonicalizes_local_directory_url() {
    let temp = tempfile::tempdir().expect("创建临时目录");
    let nested = temp.path().join("中文 目录");
    std::fs::create_dir(&nested).expect("创建嵌套目录");
    let raw = url::Url::from_directory_path(&nested).expect("构造文件 URL");

    assert_eq!(
        parse_opened_url(raw.as_str()).expect("解析目录"),
        std::fs::canonicalize(nested).expect("规范化目录")
    );
}

#[test]
fn rejects_non_file_urls_and_files() {
    let temp = tempfile::tempdir().expect("创建临时目录");
    let file = temp.path().join("文件.txt");
    std::fs::write(&file, "内容").expect("创建文件");
    let file_url = url::Url::from_file_path(file).expect("构造文件 URL");

    assert!(parse_opened_url("https://example.com/project").is_err());
    assert!(parse_opened_url(file_url.as_str()).is_err());
}

#[test]
fn queue_holds_distinct_requests_until_frontend_is_ready() {
    let queue = OpenedPathQueue::new();
    let path = PathBuf::from("/tmp/codeg-finder-test");
    let other_path = PathBuf::from("/tmp/codeg-finder-other");

    assert_eq!(queue.push(path.clone()), EnqueueResult::Queued);
    assert_eq!(queue.push(other_path.clone()), EnqueueResult::Queued);
    assert_eq!(
        queue.mark_frontend_ready(),
        vec![path.clone(), other_path]
    );
    assert!(queue.mark_frontend_ready().is_empty());
    assert_eq!(queue.push(path), EnqueueResult::Ready);
}

#[test]
fn queue_ignores_duplicate_delivery_but_accepts_a_later_open() {
    let queue = OpenedPathQueue::new();
    let path = PathBuf::from("/tmp/codeg-finder-hot-start");
    let first_at = std::time::Instant::now();

    assert_eq!(queue.push_at(path.clone(), first_at), EnqueueResult::Queued);
    assert_eq!(
        queue.push_at(
            path.clone(),
            first_at + std::time::Duration::from_millis(10)
        ),
        EnqueueResult::Duplicate
    );
    assert_eq!(
        queue.push_at(path, first_at + std::time::Duration::from_secs(1)),
        EnqueueResult::Queued
    );
}

#[test]
fn failed_event_remains_recoverable_after_repeated_retries() {
    let queue = OpenedPathQueue::new();
    let failed_path = PathBuf::from("/tmp/codeg-finder-failed");
    let later_path = PathBuf::from("/tmp/codeg-finder-later");

    assert!(queue.mark_frontend_ready().is_empty());
    queue.requeue(failed_path.clone());

    for _ in 0..4 {
        assert!(queue.remove_pending(&failed_path));
        queue.requeue(failed_path.clone());
    }
    assert_eq!(queue.push(later_path), EnqueueResult::Ready);
    assert!(queue.remove_pending(&failed_path));
    assert_eq!(
        queue.push(PathBuf::from("/tmp/codeg-finder-after-recovery")),
        EnqueueResult::Ready
    );
    assert!(queue.mark_frontend_ready().is_empty());
}

#[cfg(feature = "tauri-runtime")]
#[test]
fn background_retry_delay_continues_after_three_failures() {
    assert_eq!(retry_delay(0), std::time::Duration::from_millis(50));
    assert_eq!(retry_delay(3), std::time::Duration::from_millis(400));
    assert_eq!(retry_delay(4), std::time::Duration::from_millis(800));
    assert_eq!(retry_delay(20), std::time::Duration::from_secs(5));
}

#[test]
fn event_payload_is_consumable_by_the_frontend() {
    let event = event_for_path(PathBuf::from("/tmp/项目").as_path()).expect("有效 UTF-8 路径");

    assert_eq!(
        event,
        FinderDirectoryOpened {
            path: "/tmp/项目".to_string(),
        }
    );
    assert_eq!(
        serde_json::to_value(event).expect("序列化事件"),
        serde_json::json!({ "path": "/tmp/项目" })
    );
}

#[cfg(unix)]
#[test]
fn rejects_non_utf8_directory_path_during_parsing() {
    assert_eq!(
        parse_opened_url("file:///tmp/codeg-finder-%FF"),
        Err(OpenedPathError::NonUtf8Path)
    );
}

#[test]
fn deduplicates_one_opened_event_but_allows_a_later_open() {
    let path = PathBuf::from("/tmp/codeg-finder-test");
    assert_eq!(
        deduplicate_paths(vec![path.clone(), path.clone()]),
        vec![path.clone()]
    );
    assert_eq!(deduplicate_paths(vec![path.clone()]), vec![path]);
}
