# SDD 190 验收记录

日期：2026-11-20（北京时间）。仅记录本次实际执行并回读的步骤。

## 合入与组合检查

- [PR #261](https://github.com/workhold/lightmoni/pull/261)、[PR #263](https://github.com/workhold/lightmoni/pull/263)、[PR #262](https://github.com/workhold/lightmoni/pull/262) 已依次合入 GitHub `main`，最终提交 `c7a7aba8ffbc03482b420245c312cf87fb7b04b7`；合入后无开放 PR。
- 隔离工作树按相同顺序合并无冲突，文件树与最终 `main` 相同；`npm run version:check` 46/46、Runtime 和 AI Runtime 类型检查、Runtime/AI Runtime/Web 构建通过。
- AI Runtime 测试 89/89；相关 Runtime 测试 62 项通过、1 项环境门禁跳过。首次 Runtime 测试因尚未构建 AI Runtime `dist` 而失败，按完整构建顺序补齐后重跑通过。
- `npm audit --omit=dev` 报告 Runtime 2 项 high、AI Runtime 4 项 high。涉及的 `systeminformation`、`undici`、`@mastra/core`、`@modelcontextprotocol/server`、`zod` 与 `@earendil-works/pi-coding-agent` 锁定版本均和本次合入前的 `main` 相同；本次发布未修复这些既有依赖告警。

## 镜像发布

- 从最终 `main` 本地构建 linux/amd64 镜像，OCI revision 为 `c7a7aba8ffbc03482b420245c312cf87fb7b04b7`，容器用户为 `lightmoni`。npm、Node 与 Debian 使用公开镜像源加速下载，仍按锁文件 integrity、官方 Node SHA256 与 Debian 仓库签名验证。
- 固定标签 `v0.1.8-20261119-155555-amd64` 和 `latest` 已推送；远端回读均为 `sha256:54645fa2f564e13b942bb6928107331ed823de8e8ffdd7340f33e16b5aea16e2`，业务 manifest 为 linux/amd64。固定标签重新拉取后镜像修订号仍匹配最终 `main`。
- 镜像内双架构 Agent 与 Go、Python、Rust、TypeScript SDK 文件均通过发布清单 SHA256 校验。
- 隔离 Compose 项目的中心与 ClickHouse 均 healthy；首页、`/healthz` 为 HTTP 200，未认证实例接口为 401。初始化隔离管理员后，实例与 MCP 均报告 0.1.8。专属容器、网络、数据卷及临时凭据文件已清理。

## 生产部署

待执行并回读。当前发布镜像不等于生产中心已更新；`zz-bj-1` Agent 也不会随中心镜像自动升级。
