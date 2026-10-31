# 后端恢复卸载验证

## 实现结果

- 标准卸载保留独立凭据节点校验；恢复卸载必须管理员明确选择 `recovery` 并填写原因。两种模式均固定 SSH 目标、凭据、主机名称及原平台绑定，支持默认保留或计划中明确选择的 purge。
- 新的有界探测只输出身份状态、可用 Agent ID、身份摘要、程序证据摘要及布尔状态，不输出身份文件或配置原文。损坏但可安全读取的小文件可恢复，符号链接、过大或不可安全读取的身份拒绝执行。
- 程序证据覆盖固定程序文件、`current` 目标、当前 release / installation 元数据和程序根目录状态。审批后复验及生命周期锁内复验均要求与审批快照一致；切换 `current` 而不改身份、launcher、unit 也会拒绝。
- 固定模板与离线脚本共用路径及任务标记 guard。服务停止后再次验证路径及标记，防止检查后新出现任务或符号链接时继续删除。
- 精确撤销同时要求原平台绑定、实际有效身份及 active enrollment 的主机归属一致，而且只处理 control / data。身份不明、外部身份或无绑定场景不猜测撤销范围；不将远端 ID 自动反绑主机。实际 ID 已属另一主机时拒绝恢复卸载。
- 派发后中断或平台重启保留 unknown。核对只读，可显式选择有效凭据，明确选择失败时不自动换用其他凭据。结果、主机及绑定在事务内复核，通过 CAS 写回。
- 旧审批缺少快照时拒绝执行，提示取消重计划。旧 unknown 仅在原身份、原目标、完整移除、两持久目录保留、路径及锁全部可验证时完成；回执标明缺少原始摘要快照，不伪造历史计划。

## 已运行验证

相关后端六文件组合 **120 / 120 通过**：

```sh
cd runtime
node --import tsx --test --test-concurrency=1 \
  test/managed-machines.test.ts \
  test/agent-host-admission.test.ts \
  test/machine-agent-lifecycle.test.ts \
  test/machine-installation-recovery.test.ts \
  test/machine-installation-recovery-races.test.ts \
  test/machine-agent-updates.test.ts
```

补事务内当前目标/绑定复验后，重新运行 managed-machines 与真实凭据 admission 组合，**65 / 65 通过**；随后加入停止服务后断连的核对回归，重新运行上述完整组合得到 **120 / 120**。Runtime 类型检查及差异检查通过。

新增回归覆盖截图中的未登记凭据身份、旧绑定不一致、缺失或损坏身份、部分程序、跨主机身份拒绝、路径与锁、审批摘要变化、精确 audience 撤销、purge 中断后选新凭据只读核对，以及旧 unknown / 审批处理。真实 AgentCredentialStore 的 HTTP 回归执行 purge → 撤销原身份 → fresh 预检 → 新 enrollment → 同一主机 ID 全新安装，验证保留数据与显式清除的不同结果。

独立复核指出：停止服务后断连，原程序仍完整，但运行状态与审批不同，不应永久卡在 unknown。修正后的核对仅允许忽略服务运行状态变化；身份、程序摘要、路径和数据仍必须一致。回归确认核对记 failed、记录 `service_stopped`、解除屏障，且不重放命令或撤销凭据；程序不完整或存在锁时仍拒绝释放。

隔离 shell 回归包含 `current` 审批后变化、stop 后注入坏任务标记和符号链接、损坏身份清除、业务文件保留，以及 purge 后 fresh guard 通过。默认保留身份和配置时 fresh guard 仍拒绝，不以本轮改动静默覆盖。

## 验证边界

HTTP 使用本地服务、内存 SQLite 和可控 SSH 响应；shell 使用临时文件树、合成 Linux root stat 与 systemctl shim。它们验证控制与文件删除决策，不代表真实 SSH、Linux root 权限、systemd 或生产验收。没有访问生产或 vchive，没有发布镜像。

完整 runtime、构建、任务派发屏障、脚本交付、浏览器和 Doca 结果由本 SDD 主验收记录汇总。
