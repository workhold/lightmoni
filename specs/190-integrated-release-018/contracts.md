# SDD 190 发布契约

- 源码：`main@c7a7aba8ffbc03482b420245c312cf87fb7b04b7`；镜像标签：`docker.heyphp.com/lightmoni/lightmoni:v0.1.8-20261119-155555-amd64`。`latest` 仅为便捷别名，生产使用固定标签。
- 中心镜像平台为 linux/amd64，内置 Linux amd64/arm64 Agent 发行包；两种 Agent 包不代表中心有 arm64 镜像。
- 生产继续使用既有 Compose 项目、`.env`、主密钥、ClickHouse、状态卷与遥测卷。不得用新空卷代替生产卷；冷备份时短暂停止两个服务，恢复时只有 LightMoni 中心镜像引用改变。
- Agent 更新走现有主机管理维护协议。旧 Agent 缺失时，先通过有现场证据的状态修正解除历史围栏，再使用平台重新接入；保留受管主机、SSH 凭据、业务数据和历史审计，注销旧 Agent 身份与凭据，新 Agent 使用新身份。结果未知时按现有核对与围栏规则处理，不自动重放作业，也不把原结果改为成功。
