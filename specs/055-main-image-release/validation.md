# 发布验收记录

日期：2026-10-31（北京时间）。用户授权合入本助手的全部已提交变更、推送 Docker 和 Git。

## 源码与组合验证

[PR #33](https://github.com/workhold/lightmoni/pull/33) 合入提交 `f3f393cb56f8e755b856141df95a83f5e4dd3697`；[PR #34](https://github.com/workhold/lightmoni/pull/34) 在同步主干、解决刷新逻辑冲突并重新验证后合入，提交 `c209a1853610e951709adf8ff8053167a2aec293`。最终镜像从后者的 git archive 导出，未包含工作区未提交文件。其他作者的待合并 PR 不属于本次提交范围。

根 Runtime/AI/Web 类型检查通过，针对性证书/平台/可观测性 57 项通过。完整 npm test：Runtime 775 项中 754 通过、21 环境跳过；AI Runtime 71 项、TypeScript SDK 22 项通过，0 失败。证书浏览器 7 项、网站安装浏览器 7 组通过，页面异常均为 0。汇总见 [integration-checks.json](evidence/integration-checks.json)。

## 构建和隔离容器检查

Docker Desktop 本机完整构建 Linux arm64/amd64，沿用 Node 24.15.0 Dockerfile，包含前端、AI Runtime、双架构 Agent 与四种 SDK。公开构建镜像源、SHA/签名/integrity 验证、平台 metadata 和工具哈希见 [build-inputs.json](evidence/build-inputs.json)。已有第三方依赖和大 chunk 构建提示保留。

双平台各 12 项检查通过：非 root、架构/源码 revision、真实 ClickHouse/HTTP 健康、管理员初始化和登录、中心身份与地址、生产前端的新网站引导/证书日志、真实自签证书创建自动签发及持久化步骤、运维/任务/遥测接口、网页、四 SDK 下载校验、双 Agent 校验和当前平台 Agent 启动、AI 模块导入。见 [arm64-smoke.json](evidence/arm64-smoke.json) 与 [amd64-smoke.json](evidence/amd64-smoke.json)。ARM64 原生运行，AMD64 使用本机仿真，ClickHouse 为独立 ARM64 容器；不等同两台物理生产主机验收。

根和兼容 Compose 在普通环境与遗留 LIGHTMONI_IMAGE 环境共 4 种组合下均解析为新固定标签，健康依赖与两个持久卷保留，见 [compose-checks.json](evidence/compose-checks.json)。仅解析配置，没有升级既有实例。

隔离验收容器、网络、卷和合成运行凭据文件已清理，见 [cleanup.json](evidence/cleanup.json)。不要求或执行已有主机 Agent 自动升级，未操作真实 ACME/DNS 云账号或生产域名。

## 发布与回读

镜像仓库为 `docker.heyphp.com/lightmoni/lightmoni`；固定标签 `20261031-c209a18` 与 `latest` 均为 `sha256:d5961baaf8c85de05b0385d5b268debe133467b16a9b346d9f05836398278069`。amd64 manifest 为 `sha256:a7f9af84b7c0609a39f61419f82d1e550cae3a4f89dcdf80aa4931b8fc3e1f45`，arm64 manifest 为 `sha256:5d90d9906e54b5ec9eb1b5a40544e8fa07fcb54b172f146cd985023ee668ea0a`。本次校验 31 个本地 blob，上传 20 个缺失 blob（459196288 字节），复用 11 个既有 blob；见 [registry-summary.json](evidence/registry-summary.json)。

更新 latest 前核对其未并发变化；独立客户端回读双标签索引、平台 manifest/config，分别重新拉取 amd64/arm64，架构、revision、非 root 用户与镜像 ID 均匹配已验收镜像，见 [verified-release.json](evidence/verified-release.json)。历史 `20261030-ddd7426`、`20261031-e3d1192` 与 `20261031-8386b5b` 的摘要保持不变，见 [historical-tags.json](evidence/historical-tags.json)。凭据仅由 Docker credential helper 在进程内提供，未写入源码、命令参数、镜像或公开报告。

[GitHub Release 20261031-c209a18](https://github.com/workhold/lightmoni/releases/tag/20261031-c209a18) 绑定构建源码提交。Compose、部署说明与验收记录通过本发布分支 PR 交付，最终合入状态以该 PR 与本次收尾回执为准。配置提交晚于镜像源码，只更新发布引用与证据，不改变镜像中的应用代码。

## 架构影响

不适用：本次仅合入已交付功能、构建和发布制品、维护默认镜像及证据，不新增组件职责、后端数据/控制路径、协议、存储、凭据、拓扑或 AI/工具边界。#33 的架构同步证据保留于 SDD 053；本次没有重新写入或回读 `docs/system-design.md` 与 [Doca 系统设计基线](https://doca.heyphp.com/#/r/2902a80f-c592-414e-9aed-64fe19f2ed53)，不声称新的架构同步。
