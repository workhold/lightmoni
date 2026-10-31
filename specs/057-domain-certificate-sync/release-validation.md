# 按域名管理证书与集群同步镜像发布验收

日期：2026-10-31。沿用用户合入主分支、推送 Docker 和 Git 的明确授权，功能通过 [PR #42](https://github.com/workhold/lightmoni/pull/42) 合入 main，固定构建源码为 `aed4b2ddedcd4eb446cc4097a0e205a1aa5f52a9`，镜像标签 `20261031-aed4b2d`。部署默认引用与本记录经发布 PR 合入，不直接向 main 推送。

## 构建与检查

从 git archive 导出该 main 提交，未包含未提交的部署引用和工作区文件。本机 Docker Desktop 完整构建 linux/amd64、linux/arm64，保留 npm integrity、Debian 签名和固定 Node 发行校验，包含生产前端、AI Runtime、双架构 Agent 和四种 SDK。构建输入、工具哈希和平台 metadata 见 [build-inputs.json](evidence/release/build-inputs.json)。已有依赖 deprecation、npm nodedir 和前端 chunk 提示保留。

双平台各 13 项真实容器检查通过：非 root、源码和架构标签、隔离真实 ClickHouse/HTTP 健康、管理员初始化登录、中心身份/地址、生产前端包含域名下任务与集群选择、无名称字段创建域名命名的证书并自动签发、持久执行日志、管理员证书查看和固定版本私钥下载（实际配对及 no-store 核对）、运维/任务/遥测 API、SDK 下载校验、双 Agent 校验和本架构 Agent 启动、AI 模块导入。ARM64 原生运行，AMD64 为本机仿真，ClickHouse 采用隔离 ARM64 实例；不等同两台物理生产机。见 [arm64-smoke.json](evidence/release/arm64-smoke.json)、[amd64-smoke.json](evidence/release/amd64-smoke.json)。

功能验收的全量测试、最终相关回归、两台独立真实 Agent 的目录落盘、三轮各 18 项浏览器结果和截图自检见 [validation.md](validation.md) 及 [checks-summary.json](evidence/checks-summary.json)。旧 Agent 可使用现有协议完成集群逐机器安装。

根与兼容 Compose 在普通及遗留 LIGHTMONI_IMAGE 环境下共 4 种组合均指向新固定标签，健康依赖及两个卷保留；见 [compose-checks.json](evidence/release/compose-checks.json)。仅解析配置，现有部署需更新容器后生效。

隔离验收容器、网络、卷与合成运行凭据均已清理，见 [cleanup.json](evidence/release/cleanup.json)。未调用生产 CA/DNS，未写入生产机器目录。

## 发布与回读

`docker.heyphp.com/lightmoni/lightmoni:20261031-aed4b2d` 与 `latest` 均指向双平台索引 `sha256:4fa244357b95a3dd805f552fd3a780a8fa4f5ec7dd0cb0f11e66857f6b211759`。amd64 manifest 为 `sha256:cae7ebf9eed1d6cb39aed58cf993457c658e54fbac36d604e40ccf5e77e1af1b`，arm64 manifest 为 `sha256:e55075aaa35a4678c78a5b0a1f058ae161e34fa8decc149b544819abe287bce9`。本地校验 31 个 blob，上传 20 个缺失 blob（459317308 字节）、复用 11 个；固定标签防止覆盖不同内容，更新 latest 前检查并发变化。见 [registry-summary.json](evidence/release/registry-summary.json)。

独立 Docker 客户端回读两个标签的索引及平台描述，并按两个平台分别重新拉取；镜像 ID、源码 revision 和非 root 用户均与已验收镜像匹配。见 [verified-release.json](evidence/release/verified-release.json)。五个历史固定标签摘要保持不变，见 [historical-tags.json](evidence/release/historical-tags.json)。凭据由 Docker credential helper 在进程内提供，没有进入仓库、URL、命令参数或公开报告。

[GitHub Release 20261031-aed4b2d](https://github.com/workhold/lightmoni/releases/tag/20261031-aed4b2d) 绑定构建源码提交。部署引用和发布证据作为随后配置提交，不改变镜像中的应用代码。

## 架构影响

本次打包、版本引用与记录本身不适用：不新增组件、数据路径、协议、存储、凭据边界或部署拓扑。功能的单域名命名、集群成员解析、多 Agent 派发、载荷成员守卫与逐机器状态路径已随 PR #42 同步 `docs/system-design.md` §33.5/§33.6 和 [Doca 系统设计基线](https://doca.heyphp.com/#/r/2902a80f-c592-414e-9aed-64fe19f2ed53)，seq 895/version 896 回读两段文本及原生图匹配，全部 11 个节点、14 条连线和无关内容保留。引用 [原始同步证据](evidence/architecture-sync.json)，不声称另一次在线写入。
