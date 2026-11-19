# SDD 190 发布契约

- 源码：`main@c7a7aba8ffbc03482b420245c312cf87fb7b04b7`；镜像标签：`docker.heyphp.com/lightmoni/lightmoni:v0.1.8-20261119-155555-amd64`。`latest` 仅为便捷别名，生产使用固定标签。
- 中心镜像平台为 linux/amd64，内置 Linux amd64/arm64 Agent 发行包；两种 Agent 包不代表中心有 arm64 镜像。
- 生产继续使用既有 Compose 项目、`.env`、ClickHouse、状态卷与遥测卷。不得用新空卷代替生产卷；更新只重建 LightMoni 中心服务。
- Agent 更新走现有主机管理维护协议，保留主机身份、凭据、队列和审计。结果未知时按现有核对与围栏规则处理，不自动重放作业。
