# 发行契约

本 SDD 不新增 HTTP、心跳、SSH 或存储契约；单次入口能力门禁见 [SDD127 契约](../../127-ssh-once-readiness/contracts/README.md)，历史受管队列失败行为见 [SDD129 契约](../../129-ssh-legacy-queue-failure/contracts/README.md)。这里约束镜像发行及生产替换的可核对输入和输出。

| 项目 | 必须满足 |
| --- | --- |
| 业务源码 | GitHub `main` 合并提交 `bb132a10e1d65edd77354b09d3add32df90ec936` 的干净归档，包含 PR #176 的 SDD129 修复 |
| 固定标签 | `docker.heyphp.com/lightmoni/lightmoni:20261112-ssh-once-readiness-v3`，推送前不存在且发布后不可覆盖 |
| 平台 | 远端索引同时包含 `linux/amd64` 与 `linux/arm64` |
| 来源标记 | 两个平台的 OCI `org.opencontainers.image.revision` 均等于完整业务源码提交 |
| 镜像内容 | `/opt/lightmoni/runtime/dist/server/main.js`、两个 `lightmoni-agent_0.1.0_linux_*.tar.gz`、`/opt/lightmoni/ai-runtime/dist/runner.js` 均存在 |
| Compose 变更 | 只改变 `services.lightmoni.image`，不改变项目、网络、端口、环境、依赖、卷或 ClickHouse 服务 |
| 生产操作 | 先完成配置及 SQLite 一致备份，仅重建 `lightmoni`；原中心状态卷、ClickHouse 容器和遥测卷保留 |
| 兼容行为 | SDD127 的旧发行门禁与精确迁移发行保持有效；SDD129 的未领取旧受管队列以 `failed` / `agent_upgrade_required` 终结，不创建签名作业或连接 SSH |
| 验收 | 远端索引与 revision、Docker health、两个 `/healthz` 入口、容器和卷身份，以及可实际回读的 SDD127/129 行为均有证据 |

镜像摘要、备份校验和生产回读值须在操作发生后记录；未验证时不得填写预期值冒充结果。生产凭据与原始备份不得写入契约或验收文档。
