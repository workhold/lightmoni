# Validation Evidence — 2026-11-11

## Reproduced defect

2026-11-10 同一线上主机三次首装在身份交换前退出。保留的 Agent 服务覆盖文件配置了 `SupplementaryGroups=docker`。旧预检漏报 .service.d，旧卸载漏删，拒绝原因退化为普通退出码；只读核对失败后页面进一步要求刷新，人工恢复入口被禁用。调查期间没有执行线上清理或重装，本文不记录凭据或原始日志。

新增用例在修复前失败：两个孤立覆盖目录被观测为 absent；固定拒绝原因被映射为 remote_command_failed。修复后对应断言通过。

## Automated checks

| Command / scope | Result |
| --- | --- |
| runtime: `node --import tsx --test --test-concurrency=1 test/machine-ssh.test.ts test/install-release.test.ts test/machine-agent-lifecycle.test.ts test/agent-uninstall-script.test.ts test/machine-installation-recovery.test.ts test/machine-installation-recovery-races.test.ts` | 153/153 passed |
| runtime: `node --import tsx --test --test-concurrency=1 test/machine-maintenance.test.ts test/managed-machines.test.ts test/machine-installation-recovery.test.ts test/machine-installation-recovery-races.test.ts` | 91/91 passed；与上一组部分重叠，不累加为独立用例总数 |
| runtime: 停止服务后覆盖文件变为链接/可写的两项真实 shell 回归 | 2/2 passed，删除前拒绝，程序与业务数据保留 |
| `node scripts/test-agent-install-recovery-ui.mjs` | 7/7 passed；浏览器错误和意外请求均为 0 |
| `npm --prefix runtime run typecheck` / `run build` | Passed |
| `npm --prefix web run typecheck` / `run build` | Passed；Vite 的现有 dependency use-client 构建提示不影响成功退出 |
| `sh -n deploy/agent/install.sh` / `uninstall.sh` | Passed |
| `git diff --check` | Passed |

最终路径保护复核与 lifecycle/SSH 全量回归见 checks.json 的 final_lifecycle 结果。

页面场景：核对失败后读回成功可继续人工结束；读回失败或目标不符仍锁定；旧 running 状态不能覆盖 unknown；切换主机后丢弃旧响应且新主机入口可用；人工结束响应丢失后读回已保存结果；POST 返回其他记录时拒绝并读回。

Shell 场景：root/sudo 足迹一致；空目录、悬空链接、Agent/helper 两个覆盖目录均在 fresh 前拦截；默认卸载和 purge 保留业务数据；隐藏文件安全清理、无关服务目录保留；目录/子项链接、嵌套目录、FIFO、非 root 所有、可写、文件过大和数量过多拒绝；名称、内容、权限和目录变化被快照拒绝；停止服务后再检查路径安全。

## Fixture and environment notes

Node 26.0.0 / macOS，隔离目录内执行真实 POSIX shell。systemd 和 root 所有权由 fixture 模拟；权限、链接、摘要与文件操作真实执行，未在生产执行卸载或重装，不把本地回归称为线上验证。测试表补齐现有生产查询要求的 heartbeat 字段，修复旧 fixture 的 `no such column: a.heartbeat`，未变更生产 schema。SDK 构建后再执行 runtime 检查。

## Compatibility and architecture

- 原有常驻 Agent 非 root 和覆盖拒绝策略保持；不自动提权、忽略覆盖、删除残留或重复安装。
- 现有显式卸载清理增加两个固定覆盖目录；复杂或不安全覆盖需人工检查，数据保留规则不变。
- 卸载程序证据摘要覆盖范围增加，未执行的旧卸载计划需重新检查审阅；无数据库迁移。
- 非零退出、超时和断线仍保留 unknown；现有人工结束、撤销本次授权与审计机制沿用。
- 架构同步：不适用。此项是现有安装足迹、卸载校验和恢复交互缺陷修复，不改变组件职责、控制/数据通道、存储、协议形状、凭据边界或部署拓扑；仓库设计文档与 Doca 均不需改写。未声称完成在线同步。

## Initial delivery — before deployment authorization

基于 GitHub origin/main 570b203；提交前再次 fetch，未发现主干变化。独立工作树保留原目录的 compose.yaml 与 SDD091 未提交内容。通过功能分支 PR 交付，不合并、不发布、不改线上主机状态。

GitHub PR：[workhold/lightmoni#166](https://github.com/workhold/lightmoni/pull/166)，目标 `main`，功能分支 `codex/122-agent-install-recovery`。创建后通过 GitHub 回读确认，不执行合并或发布。

## Authorized production release — 2026-11-11

用户随后明确要求部署。PR #166 已于 2026-11-11 09:48:23（Asia/Shanghai）通过 GitHub 合入 main；固定源码为 `7011d507e1db74082c674a78f8ff3c921faf8f91`。此前“不合并、不发布”的记录描述初次交付时点，后续操作依据新增部署授权。

- 固定镜像：`docker.heyphp.com/lightmoni/lightmoni:20261111-agent-install-recovery-v1`。
- OCI 双平台索引：`sha256:60724fdbc8e0a147c55fdbbdf47c6924145beabfa584e3cabc3f4800f853bde2`；含 linux/amd64、linux/arm64，`latest` 前后保持原摘要。
- 两个平台各 11 项镜像验收通过：非 root、固定 revision、真实 ClickHouse 健康、管理员登录、Agent 下载权限拒绝、四种 SDK HTTP 下载校验、两种 Agent 成品校验和与 manifest、实际 Linux root 所有目录的编译后保护/摘要/清理、SSH 原因与页面构建内容。两个平台 Agent 二进制 `version` 均输出 0.1.0。
- Agent HTTP 下载需要主机专属接入令牌，本次没有为测试签发生产令牌；镜像内两平台成品直接逐字节校验 SHA256。SDK 通过隔离中心 HTTP 下载校验。具体证据见 `amd64-smoke.json`、`arm64-smoke.json`、`release-verification.json`。
- 生产备份完成：SQLite 一致快照 2,764,324,864 bytes，`quick_check=ok`，Compose、环境与主密钥备份保存在生产 root 私有目录 `/opt/lightmoni/backups/sdd122-agent-recovery-20261111`，未导出敏感内容。
- 生产中心于 2026-11-11 10:18:58 启动新容器，10:19:29 健康验收通过。新镜像 revision 与仓库摘要一致，配置、环境、数据卷、端口/网络、主密钥和其他容器 ID 与切换前核对一致。无需常驻 Agent 升级，无 schema 迁移。
- 对外 `/healthz` 和首页 HTTP 200。线上刷新后，4 台主机正常显示，原失败主机仍为 unknown，其他三台 Agent 在线。对原失败记录执行只读核对，实际失败后自动读回；填写原因可启用人工结束按钮，验证恢复入口不再卡住。随后清空草稿并关闭，未提交人工结束或重装。
- 受影响主机的历史 unknown 与残留仍保留；发版本身不代表远端安装成功。显式清理仍需沿已有审阅/确认流程执行。
- 回滚保留旧镜像 `20261110-monitoring-fixes-v1` 与原 Compose；部署脚本包含健康/兼容检查失败时恢复旧 Compose 和旧中心的路径。本次未触发回滚，未将准备好的回滚称为实际故障演练。

- 补充成品回归：在两个平台镜像内直接导入已发布的编译模块和卸载脚本，lifecycle 与安装竞态回归每平台共 40/40 通过（arm64 45.8 秒、amd64 本机模拟约 840 秒）。这组 systemd/所有权使用隔离 fixture，与上文真实 Linux root 文件验收区分，见 `release-verification.json`。

生产回执仅记录白名单字段，见 `production-backup.json`、`production-deployment.json`、`production-health.json`、`production-ui.json`。架构影响仍为“不适用”：沿现有 Compose、存储与凭据边界发布已有缺陷修复，未变更组件职责或部署拓扑，未改写仓库架构文档和 Doca。
