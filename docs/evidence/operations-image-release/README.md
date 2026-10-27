# 运维功能双架构镜像发布（2026-10-27）

已发布 `docker.heyphp.com/lightmoni/lightmoni:20261027-operations`，`latest` 指向相同双平台索引。两个标签均回读为 `sha256:0c314e78da2243d9e2aba641d9bab460f3dd24a78a0c4dcf2abbc389c5defeff`，支持 Linux amd64/arm64。

## 源码与构建

- 功能来源：已合入主干的 [PR #6](https://github.com/workhold/lightmoni/pull/6)，固定源码 `ac30ec91e5804e0e9ad961d7a38d2259b3eb2106`。
- 从该提交的干净快照使用 `deploy/server/Dockerfile` 完整重建中心、网页、Mastra 和两种架构的 Agent 下载包，中心仍以 `lightmoni` 用户运行。
- [构建与原生验收 run 40497221213](https://github.com/workhold/lightmoni/actions/runs/40497221213)：Linux amd64 与 arm64 原生 runner，各自成功完成 9 项检查。
- 本机下载上述成功 run 的同一批产物，校验 GitHub artifact ZIP 摘要、ZIP CRC、内层归档 SHA、每层 diff_id、revision、平台和非 root 用户。转换后的 config digest 必须等于原生验收通过的 image ID，才允许从本机上传。
- 曾尝试 GitHub 直接发布，因跨境链路缓慢而在标签写入前取消两次任务；最终按用户要求优先本机上传。临时 GitHub Secret 只注入发布步骤，已删除，并回读仓库 Secret 列表确认为空。本机发布凭据仅通过交互式 stdin 提供并保留在进程内存中，代码、报告、文档和 PR 不保存凭据。
- 发布脚本与临时工作流仅用于本次任务，从最终 PR diff 移除。构建/验收脚本见提交 `67c7fb0d49c2e07582dc5a7d4b0fdf694d73be10`，基础 OCI 打包/发布逻辑见提交 `337f9f0596e6b1a050274b1a6964de371423e2e8`；本机仅将上传传输层替换为持久 HTTP/1.1 连接，保留同源鉴权、限制响应大小和失败不重放，10 项离线传输检查通过。

## 验收证据

| 证据 | 含义 |
| --- | --- |
| [container-report.json](container-report.json) | 两架构原生验收汇总及边界 |
| [amd64-container-report.json](amd64-container-report.json)、[arm64-container-report.json](arm64-container-report.json) | 真实 ClickHouse 26.8、中心健康、stdin 初始化管理员、登录/session、网页及静态资源、匿名 401/成员 403/管理员 API、运维模块与 AI read/draft 工具检查 |
| [artifact-report.json](artifact-report.json) | 压缩归档摘要与已验收 image ID 的绑定 |
| [local-download-report.json](local-download-report.json) | 本机下载同一批 GitHub artifact 的 ZIP SHA、CRC 和内层归档 SHA 核验 |
| [downloads-report.json](downloads-report.json) | 离线逐层检查双 Agent 与 TypeScript/Go/Python/Rust SDK 及校验清单 |
| [registry-report.json](registry-report.json) | 固定标签与 latest、索引/manifest/config、独立逐层 OCI GET 摘要和长度校验 |


每个中心镜像都包含 amd64 与 arm64 Agent 包。两种中心镜像各自在原生 runner 中执行自己的 Agent `version` 入口及模块导入；对另一架构仅检查 SHA、ELF、Node 版本与运维模块。两个中心分别生成压缩包，因此同架构 Agent 在两个中心内的归档 SHA 可以不同；应以对应中心提供的清单为准。

本次镜像验收没有启动 Agent daemon、批准运维任务或执行真实 Nginx/Compose/ACME/S3 操作；HTTP 网页资源检查不等于交互浏览器全流程验收。已有真实领域测试、未验收范围及权限约束见 [SDD 026](../../../specs/026-operations-platform/validation.md) 与[运维手册](../../operations.md)。使用新建空卷完成验收，未验证存量数据升级。

本机未安装 Docker daemon，发布后的整层校验使用独立 OCI HTTP GET；原生容器执行证据来自上面的构建验收，不将 OCI 回读称作本机 Docker 拉取或本机容器执行。

## 升级与回退

本次只发布镜像，没有替换线上容器。已有 `.env` 固定旧标签时需显式更新 `LIGHTMONI_IMAGE`；沿用原 Compose 项目名、数据卷及主密钥，升级前备份，再执行 `docker compose pull` 和 `docker compose up -d`。单独拉取不会切换运行中的平台。

中心升级不会自动升级存量 Agent。节点需单独升级，并准备相应 Nginx、Docker/Compose、Certbot、端口及目录/服务权限；capability 声明不能证明这些依赖和权限已就绪。旧固定镜像 `20261027-agent-install` 保留；切回旧镜像不能替代数据恢复，具体步骤见[部署说明](../../../deploy/server/README.md)。

## 清理与架构影响

GitHub 原生验收的专属容器、卷和网络已清理，详情在每份报告的 `cleanup`。最初在 `vchive` 的构建尝试因 SSH 持续 banner 超时而停止使用；无法回读确认该主机 `/tmp/lightmoni-ops-image.ZP3I0A` 与 `lightmoni-ops-20261027` 专属 builder 的清理，未执行全局 prune 或修改其他项目。

本次仅打包、发布已合入且已同步的 SDD 026 实现，更新默认镜像标签和证据；组件、协议、凭据边界、存储及部署拓扑均无变化，仓库系统设计与 Doca 再同步不适用。
