# 发行与部署契约

- GitHub 主库 `workhold/lightmoni`，所有仓库变更通过面向 `main` 的 PR；不得直接推主干或写 Gitea。功能合入为 #185、#217、#220。
- 构建源码固定为 `eb1690bb42a47c8f5bc28df404c0d957aa9b391b`；镜像 OCI `org.opencontainers.image.revision` 和内置 Agent `source_revision` 必须等于它。发布配置提交可晚于源码提交。
- Docker 仓库 `docker.heyphp.com/lightmoni/lightmoni`；根 Compose 的 `services.lightmoni.image` 指向新固定标签 `20261114-eb1690b`，双平台 Linux amd64/arm64。`latest` 在固定标签回读和验收后更新；旧固定标签不覆盖。仅修改 Compose 引用不等于镜像已发布或生产已升级。
- 生产沿用原 Compose 项目、环境、主密钥和数据卷；只重建中心，ClickHouse、业务容器及未知任务不重建或清理。回滚使用现场回读的生产原镜像固定标签和同一存储基线；不得从仓库上一版标签推断生产原镜像。
- 凭据只经现有受保护运行时渠道提供，不写入仓库、镜像层、构建日志、URL、PR、Release 或文档。线上测试默认只读；不得为验收提交生产应用生命周期动作或人工核对回执。
