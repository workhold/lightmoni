# SDD 174 验证记录

- SDD 173 已通过 [PR #234](https://github.com/workhold/lightmoni/pull/234) 合入，merge commit `1b0d2d0a04c2afc1aa7fbdeea1cfb9fb7579acab`。
- `npm run version:bump -- 0.1.2` 已统一平台、Agent、SDK、MCP 与构建版本；`npm run version:check` 为 46/46 通过。
- Compose 固定标签为 `docker.heyphp.com/lightmoni/lightmoni:v0.1.2-20261115-152221-amd64`。
- 版本分支的类型检查、生产构建及恢复/助手定向回归 21/21 通过；Web 仅有第三方依赖 `use client` 提示。
- 当前仅完成版本准备。镜像构建、远端摘要、隔离验收、生产部署和 vchive 恢复尚未完成，不预写成功。

## 本地镜像与发布验收

- 版本 PR [ #235](https://github.com/workhold/lightmoni/pull/235) 已合入，实际构建源码为 `main@8025c47edcc2d539e9e553578dd9557c9f3b7199`。本地工作区干净，镜像 OCI revision 与该 SHA 一致。
- 本地构建仅使用 linux/amd64 固定 Node 基础镜像。官方 Node 包首次下载超时后，改用镜像站获取同一固定版本，并继续按官方 SHASUMS 验证；没有关闭摘要检查。
- 镜像内 Agent 双架构包和四种 SDK 的 SHA256SUMS 均通过；amd64/arm64 Agent 的 `source_revision`、`version=0.1.2` 与架构均正确。
- 隔离 ClickHouse + 中心启动通过：`/healthz` 和首页 200；未认证实例设置/MCP 为 401；初始化后的实例版本和 MCP `serverInfo.version` 均为 0.1.2。测试使用本机 arm64 ClickHouse 与待验收 amd64 中心容器互联，不宣称全 amd64 集群验收；临时凭据使用 0600 env 文件并已清理。
- 已推送 `docker.heyphp.com/lightmoni/lightmoni:v0.1.2-20261115-152221-amd64` 与 `latest`。远端两者摘要均为 `sha256:60c257f8c37b247fd1293206f447dd5853ae73c6df13d549db0dd002d30625c5`，固定标签的业务 manifest 平台为 linux/amd64；另一 unknown/unknown 条目是 BuildKit attestation，不是额外平台发行。
- 尚未替换生产中心，尚未恢复、升级或卸载 vchive Agent。生产部署与恢复审批仍需单独确认。
