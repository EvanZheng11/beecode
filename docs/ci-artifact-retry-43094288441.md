# Release 43094288441：artifact 服务失败与有限重试

## 实际失败

- Run：<https://github.com/EvanZheng11/beecode/actions/runs/43094288441>
- 源码 SHA：`6f453cb4c06588636bf9e2bb77d283e78a79a5b8`，标签 `v0.42.6`。
- Windows x64：job `130779257202`，失败步骤“上传桌面安装包与完整性校验文件”。构建和安装包校验已完成。
- Server Linux x64：job `130779257347`，失败步骤“Upload artifact for Docker build (Linux only)”。
- 两处相同报错：`Failed to CreateArtifact: Failed to make request after 5 attempts: Unexpected token '<', "<!DOCTYPE "... is not valid JSON`。

这是 Actions artifact 服务返回非 JSON 响应后的上传失败，不是 Rust 编译错误。现有证据不足以确定 HTML 由哪个上游组件返回，不将其猜测为代码、权限或配额缺陷。Node.js 20 deprecation 是独立警告。

匿名 GitHub REST API 查询时已触及限流（remaining=0）；本次证据来自公开 job/run HTML 的实际 annotation，不把未读取的详细日志当作已读。HTML与提取文本保存在 `/tmp/beecode-ci43094288441-2cb23f/`。

## 修复

仅对已失败的两类上传增加最多三次整步尝试：

1. 首次仍遵守原有默认成功门控，Docker输入首次仍仅运行于Linux；上游构建失败不上传。
2. 前两次用 `continue-on-error` 暂缓失败，但重试条件检查真实 `outcome == 'failure'`，而不是被改成成功的 `conclusion`。
3. 第二次前等待15秒，末次前等待30秒；取消后不继续上传。
4. 每次沿用同一矩阵内唯一artifact名，并启用 `overwrite`，应对服务端已创建但客户端未收到响应的同名残留。
5. 每次12分钟上限。桌面安装包本已压缩，设置 `compression-level: 0` 避免重复压缩；Docker输入仍保留原压缩行为和一天保留期。
6. 第三次没有 `continue-on-error`，全部失败仍让job和矩阵失败，后续Docker、manifest、publish依赖不放行。
7. 不改签名要求、资产命名、六桌面/五服务器矩阵，不改版本号或发布标签。

同一次job最多增加两个上传步骤，不引入第三方重试action。服务器签名包的另一上传步骤没有本次失败证据，不顺带扩大修改。

## 验证与边界

- `node --test scripts/release-signing-version.test.mjs scripts/generate-updater-manifest.test.mjs`：56项通过。
- 覆盖首次成功、第二次成功、第三次成功、三次全部失败、运行前取消、首次失败后取消、上游构建失败的真值表；断言末次不可忽略失败。
- YAML解析及Prettier检查通过，现有矩阵、Windows arm64、manifest及最终发布依赖契约仍通过。
- 测试属于本地工作流静态/模拟验证，没有对真实artifact服务写入，也没有证明远端run已恢复。
- 原失败run使用旧workflow。仅合回本地修复不能改变已存在run；推送修复、重跑或重新触发发布以及移动标签均需用户授权。重跑整个失败链可能继续执行正式发布，不能当作纯本地测试。
- 未安装或替换桌面应用，未访问正式数据库，不影响现有0.42.4应用入口。

## 工程隔离

原工作区 `/home/andy/git/beecode`，目标 `main`，开始HEAD为 `6f453cb4c` 且干净。修复在独占 `worktrees/wt_ci43094_2cb23f` 分支与同名worktree进行。主会话负责提交、独立审核后的本地合回和自有资源清理；不推送或发布。
