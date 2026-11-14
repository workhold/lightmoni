# SDD 155 验证记录

验证日期：2026-11-14。范围为 Slice 3 告警事件转交提案与原生执行。分支 stacked 在 SDD 154 的 `93c86db` 上，`main@acc61ef`；PR #208、#209 均 OPEN、未合入。未部署生产、未操作真实主机、未发布镜像。

## 自动化检查

| 检查 | 结果 | 覆盖 |
| --- | --- | --- |
| 全领域能力、告警计划/审批、官方 MCP 与权限定向测试 | 156/156 通过 | `/tmp/lightmoni-alert-transfer-proposal-targeted-final.log` |
| 最终 `npm --prefix runtime test` | 1860 项：1820 通过、35 跳过、5 失败 | `/tmp/lightmoni-alert-transfer-proposal-runtime-final.log`；失败集合与既有基线一致 |
| 最终 `npm run typecheck` | 通过 | `/tmp/lightmoni-alert-transfer-proposal-typecheck-final.log`；runtime、ai-runtime、web |
| 最终 `npm run build` | 通过 | `/tmp/lightmoni-alert-transfer-proposal-build-final.log`；仅有既有 Web 依赖警告 |
| Markdown 链接/代码围栏、`git diff --check`、秘密模式扫描 | 通过 | 无失效本地链接、空白错误或秘密模式 |

最终全量失败仅为 `agent-host-admission`、`machine-service-addresses`、`machine-terminal`、`managed-machines` 和 `node-lifecycle` 的既有用例，不宣称 runtime 全量通过。

## 行为与隔离 E2E 证据

- `incident.transfer` 使用真实 Alerts/AlertProposalService，只创建 `awaiting_approval`；审批前事件保持 firing，预览 after=unclaimed 不被当成已转交。
- 原生 Alert API 转交和分页重置已提取为 `Alerts.prepareTransfer/commitTransfer/resetPaging`，保留原错误状态、有效组成员、通知取消和审计语义。
- 审批后原事件变为 unclaimed、owner 清空、stage=fallback、group.fallback=member；这不代表目标成员已经接手。
- 非组成员、同 key 异输入、有限 Host、成员、grant 撤销及 incidents.read Scope 缩小均失败关闭；规则/责任组变化使旧提案失效。
- 内部 `propose_alert_change` 使用同一原生提案和 commitTransfer 路径；预览/结果不包含 private evidence、联系人、payload 或供应商响应。
- 隔离真实业务 E2E：官方 MCP 创建 incident.ack 并由管理员审批 → 再创建 incident.transfer 并由管理员审批 → 原事件真实变为 unclaimed → MCP 回读。
- 工具总数保持 49；未新增直接 transfer/Apply、升级、续期、通知重试或测试工具。

## 未验证与剩余范围

官方 MCP SDK 隔离 E2E 不等于真实 Codex/Claude OAuth、自然语言或生产环境验收；本轮未执行这些验证。其他值班动作、Agent 后续生命周期、服务回滚/核验、PR #208、Slice 4 和真实客户端矩阵仍需独立处理。

交付 PR：[workhold/lightmoni#210](https://github.com/workhold/lightmoni/pull/210)，目标为 main，依赖 #209；实现与验证完成，等待评审，未获本轮合并授权。
