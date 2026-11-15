# SDD 169 实施计划

1. 新增 `scripts/release-version.mjs`，以根 `package.json` 为事实来源提供 `check` 和 `bump <x.y.z>`，结构化更新 package locks，避免修改第三方依赖。
2. 将平台、Agent、MCP、SDK、构建默认值和文档示例统一递增到 `0.1.1`，Compose 固定到本次 UTC 时间 amd64 标签。
3. 在 README 增加 AI 推送前检查及本地发布步骤，明确版本递增只发生在发布 PR，凭据和生产环境边界不变。
4. 运行版本检查、幂等/隔离递增验证、类型检查、构建和相关回归，记录证据后创建并合入 PR。
5. 从合入后的 `main` 本地构建 Linux amd64 镜像，运行隔离容器验证版本和发行物，再推送 Compose 固定标签及便捷别名，回读仓库 digest 和镜像 revision。

## 架构影响

不适用。版本和发布流程变化不影响运行时架构，不修改 `docs/system-design.md`。
