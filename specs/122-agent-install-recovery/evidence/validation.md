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

## Delivery

基于 GitHub origin/main 570b203；提交前再次 fetch，未发现主干变化。独立工作树保留原目录的 compose.yaml 与 SDD091 未提交内容。通过功能分支 PR 交付，不合并、不发布、不改线上主机状态。
