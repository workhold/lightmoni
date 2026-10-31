# 发布验收

日期：2026-10-31（北京时间）。用户已授权合入、发布 Docker 镜像和更新 GitHub。

## 源码与合入

- [PR #27](https://github.com/workhold/lightmoni/pull/27) 已合入，合并提交 `c319eab1d26fed254d28756b4739a6975d349d3c`。
- [PR #28](https://github.com/workhold/lightmoni/pull/28) 同步最新 main、完成集成检查并解除草稿后合入，提交 `8386b5ba8763f16221ad3a8b9cf511d5e7a2e644`。
- 镜像从上述最终 main 提交的 git archive 构建；测试集成提交 `ed8925789f7e728f75d0c1577e9ba6b8030e9bfd` 与构建提交的源码树完全一致。未使用未提交工作区内容。发布配置提交晚于镜像源码，仅维护配置、部署说明与证据。

## 检查

Runtime 668 项：647 通过、21 环境跳过、0 失败；TypeScript SDK 22、Python SDK 33、AI runtime 71、Web 模型及示例 11 项通过，Go `go test -race ./...` 通过。根类型检查和 Web 构建通过；依赖模块指令、大 chunk 等既有构建提示保留。DNS 浏览器验收 8 组、13 次操作、0 页面脚本错误。详见 [integration-checks.json](evidence/integration-checks.json) 和 [dns-ui-report.json](evidence/dns-ui-report.json)。

本机 Docker Desktop 分别构建 Linux amd64/arm64，运行现有 Dockerfile 全流程：SDK、Runtime、AI、Web、双 Agent 与四种 SDK 包。公开镜像源及 SHA/签名/integrity 校验边界记录于 [build-inputs.json](evidence/build-inputs.json)。

双平台各 10 项隔离容器检查通过：非 root、源码标签、真实 ClickHouse/HTTP 健康、管理员 CLI 和登录、中心身份/内外网地址配置、DNS 批量生产 bundle、运维与任务接口、网页、四 SDK 下载/校验、双 Agent 包及当前平台 Agent 运行、AI 模块导入。ARM64 原生运行，AMD64 使用本机 ARM64 Docker 仿真，ClickHouse 为独立 ARM64 容器；不等同两台物理生产主机或真实公网/VPC 验收。详见逐平台 smoke 报告。

根 Compose 与兼容入口均解析为同一新镜像，旧 LIGHTMONI_IMAGE 不覆盖固定版本，ClickHouse 健康依赖与两个持久卷保留。详见 [compose-checks.json](evidence/compose-checks.json)。本次没有升级现有运行中的本地或生产实例。

## Docker 发布

仓库：`docker.heyphp.com/lightmoni/lightmoni`。

- 固定标签 `20261031-8386b5b` 与 `latest` 均为 `sha256:dea2d3df4284b5ffc7b28df4c6308eeebb4aee8ed4c9adcda63758984eee2605`。
- amd64 manifest：`sha256:40fa500568936840fd061f5a680a011514345f18ad0ff726704736907704435d`。
- arm64 manifest：`sha256:0bd04b5d8ce8513a709db9d75d421060d93ede81977fa6b15c4f114a5aa2de51`。
- 校验 31 个本地 blob；20 个缺失 blob 共 443,520,701 字节使用 512 KiB 分块上传，已有层复用。发布前对比验收镜像 rootfs/config，远端回读 blob 长度、manifest/config 与双标签索引。
- 独立客户端重新检查标签索引并按两平台拉取，平台、image ID、非 root 用户及源码 revision 与验收镜像一致，见 [verified-release.json](evidence/verified-release.json)。
- `20261030-ddd7426` 和 `20261031-e3d1192` 的原摘要回读不变，见 [historical-tags.json](evidence/historical-tags.json)。更新 latest 前完成并发变更检查。

Docker 凭据仅由受保护的 credential helper 在进程内提供，未写入临时 auth 文件、构建参数、仓库、URL 或报告。隔离容器、网络、卷及合成测试凭据文件均已清理，现有服务保持，见 [cleanup.json](evidence/cleanup.json)。构建镜像和本地验收报告保留供追溯。

## GitHub 与兼容说明

[GitHub Release 20261031-8386b5b](https://github.com/workhold/lightmoni/releases/tag/20261031-8386b5b) 指向构建源码提交，包含镜像摘要、合入功能与验收限制。Compose、README 和部署说明经本发布功能分支 PR 交付；该 PR 按用户授权合入后再同步本地 main，最终状态以 GitHub PR 与交付回执为准。

新 Agent 不再转发业务 SDK；历史 SDK→Agent 用户须在升级 Agent 前改为中心 endpoint 与 SDK Key，新 SDK 需要显式中心 endpoint。中心镜像不会自动升级既有 Agent。本次未执行现有实例升级、生产网络或云 DNS 验收。

## 架构判断

不适用。本次仅打包和发布已合入功能、维护默认镜像与说明，不新增系统职责、数据或控制路径、协议、存储、凭据边界或拓扑。#28 的架构同步和版本 884 回读证据保留在其 SDD/PR；本次不重新改写 `docs/system-design.md` 或 [Doca 基线](https://doca.heyphp.com/#/r/2902a80f-c592-414e-9aed-64fe19f2ed53)，不声称执行新的 Doca 写入/回读。
