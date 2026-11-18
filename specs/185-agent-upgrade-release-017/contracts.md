# SDD 185 发布契约

- 统一版本为 0.1.7；Compose 使用 `docker.heyphp.com/lightmoni/lightmoni:v0.1.7-<UTC 时间>-amd64` 固定标签，不使用 `latest` 作为生产固定引用。
- 镜像 `org.opencontainers.image.revision` 等于本次版本 PR 合并后的完整 `main` 提交 SHA；内置 Agent 双架构发行包与 SDK 仍由现有 Dockerfile 构建。
- 生产沿用原 Compose 项目、环境、主密钥和外部数据卷；中心镜像更新本身不修改已安装 Agent。Agent 升级使用原 `/api/v1/machines/:id/agent-updates/start` 与维护回执流程。
