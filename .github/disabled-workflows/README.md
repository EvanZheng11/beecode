# 已停用的工作流备份

这里的文件不会被 GitHub Actions 扫描执行（GitHub 只读取 `.github/workflows/` 顶层目录）。
保留仅为可随时恢复。

- `test.yml`：原先在 `push` 到 main 和 `pull_request` 时运行前端 lint/vitest/build
  与三平台 Rust 测试。2026-10-23 按需求停用，CI 不再跑测试。
  如需恢复：`git mv .github/disabled-workflows/test.yml .github/workflows/test.yml`
