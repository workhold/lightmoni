# SDD 176 验证记录

- SDD 175 已通过 [PR #238](https://github.com/workhold/lightmoni/pull/238) 合入。
- `npm run version:bump -- 0.1.3` 已完成，`npm run version:check` 为 46/46 通过。
- 版本分支类型检查与生产构建通过；Web 仅有既有第三方依赖提示。镜像构建、发布、生产部署和 vchive 恢复尚未完成，不预写成功。

## 镜像发布验收

- 版本 PR [#239](https://github.com/workhold/lightmoni/pull/239) 已合入，构建源码为 `main@f6c2c8d708ef7f393ef6c7b25b022394d6e61615`，OCI revision 与双架构 Agent source_revision 均一致。
- 镜像内 Agent/SDK SHA256SUMS、隔离健康、首页、未认证 401、实例版本与 MCP 0.1.3 均通过。隔离环境使用本机 arm64 ClickHouse 与待验收 amd64 中心互联，不宣称全 amd64 集群验收。
- 固定标签 `docker.heyphp.com/lightmoni/lightmoni:v0.1.3-20261115-164421-amd64` 与 `latest` 已发布，远端摘要均为 `sha256:6df8ee31b759dfcd2126532717a1503575af87e9809db932537d218fa7cc8026`，业务 manifest 为 linux/amd64。
- 尚未执行生产中心替换、vchive 状态修正或重新安装。
