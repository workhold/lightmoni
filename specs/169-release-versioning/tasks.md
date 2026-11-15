# SDD 169 实施任务

- [x] T001 盘点根包、平台、Agent、MCP、SDK、Dockerfile、Compose 和现有本地发布流程的版本点。
- [x] T002 [US1] 新增 `scripts/release-version.mjs` 与根 `package.json` 的 `version:check`、`version:bump` 命令，覆盖结构化 lock 更新和 Compose 固定标签。
- [x] T003 [US1][US2] 将登记的平台、Agent、MCP、SDK、构建默认值和文档示例统一升级到 `0.1.1`。
- [x] T004 [US3] 更新 `README.md` 的 AI 推送前检查和本地镜像发布流程，不包含任何凭据。
- [x] T005 运行版本一致性/隔离递增、类型检查、构建和相关回归，填写 `specs/169-release-versioning/validation.md`。
- [x] T006 同步 `origin/main`、提交版本 PR，经检查后用 merge commit 合入。
- [x] T007 从合入后的 `main` 本地构建并验证 amd64 镜像，推送固定标签及别名，回读 digest、OCI revision 和最终 Compose。
