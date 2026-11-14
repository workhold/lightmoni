# SDD 158 验证记录

验证日期：2026-11-14。范围为 Slice 3 通知重试提案与原生 outbox 排队。分支 stacked 在 SDD 157 的 `4d589d2` 上，`main@acc61ef`；PR #208～#212 均 OPEN、未合入。未部署生产、未操作真实主机、未调用真实供应商、未发布镜像。

## 自动化检查

| 检查 | 结果 | 覆盖 |
| --- | --- | --- |
| 全领域能力、告警计划/审批、官方 MCP 与权限定向测试 | 163/163 通过 | `/tmp/lightmoni-delivery-retry-proposal-targeted-final.log` |
| 最终 `npm --prefix runtime test` | 1867 项：1827 通过、35 跳过、5 失败 | `/tmp/lightmoni-delivery-retry-proposal-runtime-final.log`；失败集合与既有基线一致 |
| 最终 `npm run typecheck` | 通过 | `/tmp/lightmoni-delivery-retry-proposal-typecheck-final.log`；runtime、ai-runtime、web |
| 最终 `npm run build` | 通过 | `/tmp/lightmoni-delivery-retry-proposal-build-final.log`；仅有既有 Web 依赖警告 |
| Markdown 链接/代码围栏、`git diff --check`、秘密模式扫描 | 通过 | 无失效本地链接、空白错误或秘密模式 |

最终全量失败仅为 `agent-host-admission`、`machine-service-addresses`、`machine-terminal`、`managed-machines` 和 `node-lifecycle` 的既有用例，不宣称 runtime 全量通过。

## 行为与隔离 E2E 证据

- `delivery.retry` 使用真实 Alerts/AlertProposalService，仅 failed/unknown/expired 可创建；其他状态失败关闭，unknown 未明确确认时拒绝。
- 原生重试排队已提取为 `Alerts.prepareDeliveryRetry/commitDeliveryRetry`，保留状态白名单、可能重复发送确认、attempts=0 和 next_attempt=now 语义。
- 审批后原 outbox=queued，等待原通知 worker；预览/结果不包含 private contact、payload、供应商响应或原始错误。
- 同 key 幂等、异输入冲突；有限 Host、成员、grant 撤销及 notifications.read Scope 缩小均失败关闭。undefined 字段过滤保证持久化前后预览指纹一致。
- 内部 `propose_alert_change` 使用同一原生提案和 updateDelivery 路径，保持规则/静默及值班动作兼容。
- 隔离真实业务 E2E：官方 MCP 创建 delivery.retry → 原管理员 HTTP Apply → 原 outbox 真实变为 queued → 官方 MCP 回读。未调用真实供应商，未宣称通知已送达。
- 工具总数保持 49；未新增直接 retry/Apply 或通知测试工具。

## 未验证与剩余范围

官方 MCP SDK 隔离 E2E 不等于真实 Codex/Claude OAuth、自然语言或生产环境验收；本轮未执行这些验证，也未验证真实供应商投递。通知测试、Agent 后续生命周期、服务回滚/核验、PR #208、Slice 4 和真实客户端矩阵仍需独立处理。

交付状态：实现与验证完成，等待 PR 评审；未获本轮合并授权，不自动合并。
