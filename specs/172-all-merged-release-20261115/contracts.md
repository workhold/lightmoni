# 发行与部署契约

- GitHub `workhold/lightmoni` 为唯一写入主库；所有代码及发行配置通过面向 `main` 的 PR 合入，不向 Gitea 写入，不直接推送主干。
- 镜像 `docker.heyphp.com/lightmoni/lightmoni` 使用 SDD169 的 `v0.1.1-<YYYYMMDD>-<HHMMSS>-amd64` 新固定标签，不复用旧标签。源码 SHA、OCI `org.opencontainers.image.revision` 与内置双架构 Agent `source_revision` 必须一致；平台镜像仅为 Linux amd64。`latest` 仅在固定标签隔离验收后更新，旧标签保留。
- 根 Compose 的 `services.lightmoni.image` 固定到新标签；生产沿用原环境、主密钥、数据卷和 ClickHouse，只重建中心。现场原镜像及备份构成回滚点。
- 凭据仅通过受保护运行时渠道提供，不写入仓库、日志、镜像层、URL、PR、Release 或文档。生产验收默认只读，不提交应用部署/停止/卸载、未知回执、服务主体调用或任务提案。
- #218/#219 的服务凭据、授权和任务续行契约以 SDD167/171 为准；本发行不改变这些接口或授权语义。
