# 发行契约

本 SDD 不新增 HTTP、心跳、SSH 或存储契约；运行时能力契约见 [SDD127](../../127-ssh-once-readiness/contracts/README.md)。这里约束镜像发行及生产替换的可核对输入和输出。

| 项目 | 必须满足 |
| --- | --- |
| 业务源码 | GitHub `main` 合并提交 `9ec010acd732a3bca5938236a429b3b64a88d941` 的干净归档 |
| 固定标签 | `docker.heyphp.com/lightmoni/lightmoni:20261112-ssh-once-readiness-v2`，推送前不存在且发布后不可覆盖 |
| 平台 | 远端索引同时包含 `linux/amd64` 和 `linux/arm64` |
| 来源标记 | 两个平台的 OCI `org.opencontainers.image.revision` 均等于完整业务源码提交 |
| 镜像内容 | `/opt/lightmoni/runtime/dist/server/main.js`、两个 `lightmoni-agent_0.1.0_linux_*.tar.gz`、`/opt/lightmoni/ai-runtime/dist/runner.js` 均存在 |
| Compose 变更 | 只改变 `services.lightmoni.image`，不改变项目、网络、端口、环境、依赖、卷或 ClickHouse 服务 |
| 生产操作 | 先完成配置与 SQLite 一致备份，仅重建 `lightmoni`；原有中心状态卷及 ClickHouse 容器和遥测卷保留 |
| 验收 | 远端索引与 revision、Docker health、两个 `/healthz` 入口、容器和卷身份，以及 SDD127 兼容行为均有实际回读证据 |

镜像摘要、备份校验和生产回读值在操作发生后记录；未验证时不得填写预期值冒充结果。生产凭据与备份文件不得写入契约或验收文档。
