# 证书查看下载镜像发布验收

日期：2026-10-31。沿用用户合入主分支、推送 Docker 和 Git 的明确授权，功能通过 [PR #36](https://github.com/workhold/lightmoni/pull/36) 合入 main，构建源码为 `6dae46ce1aeb511e2af2d3815191524cf095a6a8`。镜像标签 `20261031-6dae46c`；配置及验收记录通过同 SDD 的发布记录 PR 合入，不直接向 main 推送。

## 构建与检查

使用 git archive 导出固定提交，未包含工作区未提交文件。本机 Docker Desktop 完整构建 linux/amd64、linux/arm64，保留 npm integrity、Debian 签名与固定 Node 发行校验，包含生产前端、AI Runtime、双架构 Agent 和四种 SDK。构建输入、工具哈希和平台 metadata 见 [build-inputs.json](evidence/release/build-inputs.json)。依赖已有 deprecation、npm nodedir 和前端 chunk 提示保留。

双平台各 13 项容器检查通过：非 root、架构/源码标签、真实 ClickHouse/HTTP 健康、管理员初始化登录、中心身份/地址、生产前端、真实自签签发及步骤日志、管理员公开证书查看和固定版本私钥附件（实际核对匹配与 no-store）、运维/任务/遥测 API、SDK 下载校验、双 Agent 校验和当前架构 Agent 启动、AI 模块导入。ARM64 原生运行，AMD64 为本机仿真，ClickHouse 使用隔离 ARM64 实例；不等同两台物理生产机验收。见 [arm64-smoke.json](evidence/release/arm64-smoke.json)、[amd64-smoke.json](evidence/release/amd64-smoke.json)。功能层 67 项相关测试、3 轮各 13 项浏览器结果见 [功能验收](validation.md)。

根与兼容 Compose 在普通环境和遗留 LIGHTMONI_IMAGE 环境共 4 种组合下均指向新固定标签，健康依赖及两个卷保留。见 [compose-checks.json](evidence/release/compose-checks.json)。仅解析配置，没有升级既有部署。

隔离验收容器、网络、卷与合成运行凭据均已清理，见 [cleanup.json](evidence/release/cleanup.json)。没有对真实 ACME、DNS 或生产域名发起请求。

## 发布与回读

`docker.heyphp.com/lightmoni/lightmoni:20261031-6dae46c` 与 `latest` 均指向双平台索引 `sha256:3ca38080daef556ab28c7b1fa35600885fd01a868b3fd4d6112b941b215ed2ed`。amd64 manifest 为 `sha256:6167278bb24c5051294d029792a582c822c324108fcd0b50260d5fd5bd03b4ae`，arm64 manifest 为 `sha256:2c302c21f3c6c2ee15615a1485013724ee323ca85b86857c2178b7c54c32b13a`。本地校验 31 个 blob，上传 20 个缺失 blob（459265791 字节）、复用 11 个；发布前校验固定标签不可覆盖不同内容与 latest 并发变化。见 [registry-summary.json](evidence/release/registry-summary.json)。

独立客户端回读双标签索引与平台描述，按两个平台重新拉取，镜像 ID、源码 revision 与非 root 用户均匹配已验收镜像。见 [verified-release.json](evidence/release/verified-release.json)。历史四个固定标签摘要保持不变，见 [historical-tags.json](evidence/release/historical-tags.json)。凭据仅由 Docker credential helper 在进程内提供，没有进入仓库、URL、命令参数或公开报告。

[GitHub Release 20261031-6dae46c](https://github.com/workhold/lightmoni/releases/tag/20261031-6dae46c) 绑定构建源码提交。部署引用与证据为后续配置提交，不改变镜像中的应用代码；发布记录 PR 合入状态见本次 GitHub 交付回执。

## 架构影响

本次打包、版本引用与发布本身不适用：不新增组件、数据路径、协议、存储、凭据或部署拓扑。新增证书浏览器导出路径已随功能 PR #36 同步 docs/system-design.md §33.5/§33.6 和 [Doca 系统设计基线](https://doca.heyphp.com/#/r/2902a80f-c592-414e-9aed-64fe19f2ed53)，最新保存版本回读文本、原生图块节点与连线完整一致；本发布 PR 引用 [原始同步证据](evidence/architecture-sync.json)，不声称另一次在线写入。
