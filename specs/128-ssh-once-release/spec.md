# SDD128：SSH 单次命令就绪判断发布

## 目标

将已合入 GitHub `main` 的 SDD127 SSH 单次入口就绪判断，作为固定的双架构中心镜像发布；更新根 Compose 的中心镜像标签，并在现有生产 LightMoni 项目中仅替换中心服务。生产验收必须区分中心升级与各主机 Agent 升级。

构建业务源码固定为合并提交 `9ec010acd732a3bca5938236a429b3b64a88d941`（含 PR #174）；候选标签为 `docker.heyphp.com/lightmoni/lightmoni:20261112-ssh-once-readiness-v2`。该标签只有在确认未被占用、推送及验证成功后才能作为发行物使用。

## 要求

- **发行身份**：从上述提交的干净源码归档构建，不包含工作树未提交内容。镜像的 `org.opencontainers.image.revision` 在 `linux/amd64` 与 `linux/arm64` 上都必须等于该完整提交。固定标签不可覆盖任何现有内容；保存远端索引和两个架构清单摘要。
- **发行内容**：两个架构都能启动中心入口，并包含 amd64、arm64 Agent 下载包及 AI runner。通过实际拉取、镜像检查和最小启动检查确认；构建保留 TLS、包完整性和 Debian 签名校验。
- **Compose 合入**：根 `compose.yaml` 只将 `lightmoni.image` 固定为新标签。通过配置检查和 GitHub 面向 `main` 的 PR 合入；不得直接推送主干。镜像验证完成前不得将尚未存在的标签作为已发布事实。
- **生产保护**：部署前核对当前镜像、容器、卷和未完成的签名任务；在生产 root 私有目录保存原 Compose、环境、主密钥与 SQLite 在线一致快照，独立 `PRAGMA quick_check` 为 `ok`。生产秘密和原始备份不进入仓库或发布记录。
- **受控部署**：仅拉取并重建 `lightmoni` 服务，保留 ClickHouse 容器与所有现有数据卷；核对镜像摘要、Docker health、本机及公网 `/healthz`。失败按原 Compose 和已验证旧镜像回退，不将未确认步骤记为成功。
- **兼容验收**：旧 Agent 未证明单次入口时，新的中心应在远端 SSH 前返回可读的升级原因；已在线验证的精确旧发行 `16b151337cc94c1b7f3f7de56bdcad561759c85b` 继续满足 SDD127 的迁移例外；新 Agent 包应声明对应单次能力。中心镜像更新不自动升级各主机 Agent，不能因此声称所有主机已兼容或在线。
- **证据**：记录发行索引、两个架构清单、revision、Compose 检查、生产备份校验、部署前后容器和卷身份、健康与兼容回读。只记录非敏感状态和摘要。

## 架构影响

不适用。本 SDD 仅发行并部署 SDD127 已批准的实现，以及更新现有 Compose 中心镜像标签；不再改变组件职责、心跳协议、控制路径、凭据边界、存储或部署拓扑。相关架构变更已在 [SDD127 验收记录](../127-ssh-once-readiness/validation.md)中同步至仓库系统设计和 Doca，并完成最新版本回读。
