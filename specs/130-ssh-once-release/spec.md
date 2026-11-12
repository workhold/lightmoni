# SDD130：SSH 单次就绪与历史队列修复发布

## 目标

将已合入 GitHub `main` 的 SDD129 历史受管队列升级失败码修复，连同 SDD127 SSH 单次入口就绪门禁，作为新的固定双架构中心镜像发布。根 Compose 仅更新中心镜像标签；v2 只合入仓库、从未部署生产，本次生产应从实际运行的旧镜像直接切换 v3，并在操作前回读确认旧镜像身份。生产在现有 LightMoni 项目中仅替换中心服务。中心升级与各主机 Agent 升级分别验收。

构建业务源码固定为合并提交 `bb132a10e1d65edd77354b09d3add32df90ec936`（含 PR #176；此前已含 PR #174、#175）；候选标签为 `docker.heyphp.com/lightmoni/lightmoni:20261112-ssh-once-readiness-v3`。该标签须在推送前确认未被占用，并在推送与独立验证成功后才能作为发行物使用。

## 要求

- **发行身份**：从上述提交的干净源码归档构建，不包含工作树未提交内容。远端索引须包含 `linux/amd64` 与 `linux/arm64`；两个架构镜像的 `org.opencontainers.image.revision` 均须等于完整源码提交。固定标签不可覆盖已有内容；记录索引及两个架构清单摘要。
- **发行内容**：两个架构都能启动中心入口，并包含 amd64、arm64 Agent 下载包及 AI runner。实际拉取、检查镜像与下载包并作最小启动检查；构建保留 TLS、包完整性和 Debian 签名校验。
- **Compose 合入**：根 `compose.yaml` 只将 `services.lightmoni.image` 从 v2 固定为 v3。通过配置检查和 GitHub 面向 `main` 的 PR 合入；不得直接推送主干。镜像验证前不得声称标签已经发布。
- **生产保护**：部署前核对当前镜像、中心与 ClickHouse 容器、状态与遥测卷，以及未完成的签名任务；在生产 root 私有目录保存原 Compose、环境、主密钥与 SQLite 在线一致快照，独立执行 `PRAGMA quick_check` 并得到 `ok`。生产秘密与原始备份不进入仓库或发布记录。
- **受控部署**：仅拉取并重建 `lightmoni` 服务；保留 ClickHouse 容器与所有现有数据卷。核对远端镜像摘要、运行镜像 revision、Docker health、本机及公网 `/healthz`。失败按原 Compose 与已验证的旧镜像回退，不将未确认步骤记为成功。
- **兼容验收**：旧 Agent 缺少对应单次入口时，SDD127 的新计划门禁仍须在排队和 SSH 前提示升级；精确迁移发行 `16b151337cc94c1b7f3f7de56bdcad561759c85b` 继续按其已验证能力放行。对升级前已排队、尚未领取且当前 helper 缺少 `managed-once` 的受管 `agent_jobs`，SDD129 修复须使原作业和领域结果进入 `failed`，回执与事件保留 `agent_upgrade_required`，不创建签名 `privileged_jobs` 或连接 SSH。其他审批错误、已领取和 `unknown` 作业沿原契约处理。中心镜像更新不自动升级主机 Agent。
- **证据**：记录发行索引、架构清单、revision、Compose 检查、生产备份校验、部署前后容器和卷身份、健康与 SDD127/129 兼容回读；只记录非敏感状态和摘要。

## 架构影响

不适用。本 SDD 仅发行已合入的 SDD127 能力门禁与 SDD129 旧队列终态修复，并更新现有 Compose 的中心固定镜像标签；不再改变组件职责、协议、控制路径、凭据边界、存储或部署拓扑。SDD127 的架构变更已在[仓库系统设计第 127 章](../../docs/system-design.md)与 [Doca《LightMoni 系统设计基线》](https://doca.heyphp.com/#/r/2902a80f-c592-414e-9aed-64fe19f2ed53)同步并回读，证据见 [SDD127 验收记录](../127-ssh-once-readiness/validation.md)。SDD129 的非架构性终态修复及其理由见 [SDD129 规格](../129-ssh-legacy-queue-failure/spec.md)与[验收记录](../129-ssh-legacy-queue-failure/validation.md)；本次不为形式要求改写设计正文。
