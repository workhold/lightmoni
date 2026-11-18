# SDD 185 验证记录

日期：2026-11-18。仅记录已完成并回读的步骤；生产切换与 Agent 升级结果待执行后补录。

## 版本准备

- PR #256 已合入 `main`，合并提交为 `1f3d61446fa772d0829d36ef5f95d1b7353d30b2`。
- 版本脚本统一平台、Agent、SDK、MCP 为 0.1.7；Compose 固定标签为 `docker.heyphp.com/lightmoni/lightmoni:v0.1.7-20261118-132142-amd64`。
- `npm run version:check` 46/46 通过；`npm run build`、`npm run typecheck` 通过；Agent 升级、中心 SSH 派发和能力投影定向测试 101/101 通过。待版本 PR 合入后，从其 `main` 提交构建并核对镜像。
