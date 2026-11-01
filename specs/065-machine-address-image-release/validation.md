# 发行验收

2026-11-01（Asia/Shanghai）。用户授权推送 GitHub、经 PR 合入 main 并更新 Docker。功能 [PR #51](https://github.com/workhold/lightmoni/pull/51) 已合入，固定源码 `eb62ca6c1945a78726402d0949c1e258ce9f0638`；构建上下文为该提交的 git archive，不包含工作区、Git元数据或运行时凭据。后续默认引用/文档提交不改变镜像代码。

已发布 `docker.heyphp.com/lightmoni/lightmoni:20261101-eb62ca6` 和 `latest`，两个标签回读同一双平台 OCI 索引 `sha256:dd4e1465e93ad6ed09c233b503c5f95caa265d2bb28dfd752c96a30335d1d1b7`。支持 linux/amd64、linux/arm64。31个本地 OCI blob SHA256、测试镜像 rootfs/config、远端 blob HEAD 与 manifest/config/index GET 均核对；独立 Docker CLI 重新拉取两个平台，rootfs/config/revision 与测试镜像完全一致。21个历史标签摘要未改变。

证据：[构建材料](evidence/build-inputs.json)、[已合入功能](evidence/feature-merge.json)、[注册表](evidence/registry-summary.json)、[独立拉取](evidence/verified-release.json)、[历史标签](evidence/historical-tags.json)。凭据仅通过受保护 Docker helper 在进程中使用，不进入仓库或输出。

两个平台各19项真实容器检查通过、0失败，见 [amd64](evidence/amd64-smoke.json)、[arm64](evidence/arm64-smoke.json)。包括非root/架构/revision、真实隔离 ClickHouse 与 HTTP 健康、管理员CLI/登录、生产网页与共享机器地址模块、安装API、证书/密钥、运维/任务/遥测API、SDK下载与校验、匹配平台 Agent 启动/能力/本机复用模块、AI模块导入。amd64使用本机 Docker 仿真，arm64原生；不代表两台物理机器或生产业务验收。SDD 064 的85项定向测试和三轮浏览器结果保留，本次未重复运行或声称全量测试通过。

根 Compose 与兼容目录、有/无旧 LIGHTMONI_IMAGE 共四种组合通过，固定镜像、服务/卷和健康依赖保持，见 [Compose检查](evidence/compose-checks.json)。diff检查通过。本次隔离测试容器/网络/卷和权限0600临时环境凭据已清理，见 [清理回执](evidence/cleanup.json)；既有共享服务未改动，原始归档/无凭据日志位于忽略目录 .local-dev/image-release-065/。

[GitHub Release 20261101-eb62ca6](https://github.com/workhold/lightmoni/releases/tag/20261101-eb62ca6) 指向同一源码，见 [发行回执](evidence/github-release.json)。默认 Compose、部署文档与本证据通过 GitHub 功能 PR 交付并按已有授权合入。镜像发布不等于线上容器已重建，仍需沿用原项目、环境和卷执行 pull/up；既有 Agent 不会自动升级，本机镜像优化需升级 Agent。

架构同步不适用：本次只打包已合入的功能并更新默认引用，不新增职责、数据/控制路径、协议、存储、凭据边界或拓扑。保留 SDD 064 同一功能PR中的 [系统设计第64节](../../docs/system-design.md)、[Doca基线](https://doca.heyphp.com/#/r/2902a80f-c592-414e-9aed-64fe19f2ed53) 和 [完整原生块回读](../064-machine-service-addresses/evidence/doca-readback.json)，不重复改写在线设计。
