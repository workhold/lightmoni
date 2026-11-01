# 发布验收

日期：2026-11-02。用户授权所有相关会话合入 GitHub main 并发布 Docker，随后明确要求补齐 #64 的迁移和验收后一起发布。

## 源码与制品

[PR #62](https://github.com/workhold/lightmoni/pull/62)、[#63](https://github.com/workhold/lightmoni/pull/63)、[#64](https://github.com/workhold/lightmoni/pull/64)、[#65](https://github.com/workhold/lightmoni/pull/65)、[#66](https://github.com/workhold/lightmoni/pull/66) 均通过 PR 合入 main，见[合并回执](evidence/merged-feature-prs.json)。最终生产源码 `ccbb85d3156f428c297422dc679cab3cc215b5dd` 的 git archive 是唯一构建上下文，SHA256 为 `2c074434e4f5073e3e396d41f20c609758bfe2643fa92c9f58381df22205da77`；工作区、凭据和临时工具不进入镜像上下文。#66 修正移除旧 upgrade.sh 后的共享打包清单，失败候选没有发布。见[构建材料](evidence/build-inputs.json)及[amd64](evidence/amd64-build.json)/[arm64](evidence/arm64-build.json)基础镜像、参数和构建元数据。

`docker.heyphp.com/lightmoni/lightmoni:20261102-ccbb85d` 与 `latest` 均已远端回读为 OCI 索引 `sha256:df2484b8a9cacd19862eeb710e5f50634d689f50a8f76181d8e92611985a8a29`，支持 linux/amd64、linux/arm64。31 个 blob 的本地 SHA256、大小以及实测 config/rootfs 均校验；远端 manifest/config/index 回读后，两平台独立 Docker pull 再次确认内容与实测镜像相同。固定标签拒绝异内容覆盖，latest 更新前核对原摘要并检测并发发布。26 个历史固定标签摘要均不变，见[发布摘要](evidence/registry-summary.json)、[拉取核验](evidence/verified-release.json)及[历史标签](evidence/historical-tags.json)。

## 正式镜像验收

- 两平台各 34 项检查通过，使用非 root 生产中心与真实隔离 ClickHouse，见 [amd64](evidence/amd64-smoke.json)、[arm64](evidence/arm64-smoke.json)。包含登录/身份、实际管理 API、31项应用目录、Logo/YAML/证书、四种 SDK/双平台共享包校验、匹配平台 Agent 运行，以及三类执行器权限默认关闭。
- 实际下载的匹配平台共享包通过统一维护的固定解析器、完整发行树指纹及内嵌 Node SHA256 校验；普通 Agent unit 无 Docker 组/capability，root 受管运维和统一维护入口存在。原卸载续办与按 registry 精确代理均保留，来源 API CAS 和内外网服务地址实际写入/读回通过。
- 从生产编译模块运行签名观测，核验当前权限与应用归属，经中心加密持久 outbox ACK/去重、真实 Ingest.internal/Catalog 写入隔离 ClickHouse，再以专用只读账号读回精确日志、service/application 绑定。测试身份是隔离夹具，不冒称线上主机观测验收；只读临时账号已删除。
- 两平台全部47个网页 JS/CSS 文件名与内容组合 SHA256 一致：`ac0f414b04a0f0eeb4ee99f4b449b62e440ff3a3b14679cf45856f37a634ef49`。各平台均核对卸载续办/状态与固定布局、独立镜像来源页、网站发布、服务地址和执行器权限/维护入口，见[资源核对](evidence/feature-smoke.json)。本轮没有重复声称整套网页浏览器实机验收。
- 根 Compose 与兼容入口、有/无旧 LIGHTMONI_IMAGE 共四种组合均使用新固定镜像，原服务、健康依赖与命名卷保留，见[Compose检查](evidence/compose-checks.json)。
- 临时发行容器、网络、卷和0600凭据文件已清理。原有31个容器（15个运行）ID、名称、镜像、状态均保持，失败QA的unknown现场保留且自有QA已停服，见[清理记录](evidence/cleanup.json)。原日志和工具在被忽略的 `.local-dev/image-release-079/`。

## 功能验收与兼容边界

#64 的统一维护/repair与普通通道收口已保留，#65 补齐受管业务、签名观测、领域回执与旧数据接管。最终隔离 Linux/systemd/Docker 主链11/11、离线迁移7/7（68个审阅文件）、生产组件浏览器85/85、AI71/71及 runtime/AI/web 构建均通过，详见 [SDD080](../080-executor-managed-operations/validation.md)。完整 runtime 扫描1550项为1513通过/15失败/22环境跳过，并非一次全绿；全部失败覆盖在修正夹具后的复跑，最后当前权限/managed/维护79/79通过。没有把合成维护元数据或macOS模拟当成真实amd64 root主机验收。

普通 Agent 保持非 root、无 Docker 权限。应用、网站、Compose、证书、备份与制品发布改由独立执行器默认关闭的 `operations.managed.v1`，由管理员单独审阅授权。旧业务先按[停机接管步骤](../080-executor-managed-operations/migration-runbook.md)审阅精确摘要，保留源数据、UID/GID与回执；不通过清空真实unknown、业务目录或重新注册绕过。程序升级/回退/repair/卸载走统一维护，不删除业务数据或恢复已撤销策略。

此次只发布 GitHub/Docker，不自动更新生产中心、Agent、业务容器，不自动授权或迁移用户主机。镜像代理是独立“镜像来源”页的按 registry 规则，与私有仓库管理分开。

架构同步：本发行打包不适用，不改变职责、协议、凭据、存储或拓扑。功能PR已同步仓库系统设计第80章及 [Doca基线](https://doca.heyphp.com/#/r/2902a80f-c592-414e-9aed-64fe19f2ed53)，SDD080最新930回读确认文字、原生图及10节点/10连线；发行不重复改写设计。

[GitHub Release](https://github.com/workhold/lightmoni/releases/tag/20261102-ccbb85d) 指向同一实测源码；发布回执见 `evidence/github-release.json`。默认镜像、部署说明和本验收由[发行PR #67](https://github.com/workhold/lightmoni/pull/67)交付main，最终合入状态以GitHub回执核对。
