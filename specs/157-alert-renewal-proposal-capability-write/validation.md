# SDD 157 验证记录

验证日期：2026-11-14。范围为 Slice 3 告警值班续期提案与原生执行。分支 stacked 在 SDD 156 的 `625b110` 上，`main@acc61ef`；PR #208～#211 均 OPEN、未合入。未部署生产、未操作真实主机、未发布镜像。

## 自动化检查

| 检查 | 结果 | 覆盖 |
| --- | --- | --- |
| 全领域能力、告警计划/审批、官方 MCP 与权限定向测试 | 160/160 通过 | `/tmp/lightmoni-alert-renewal-proposal-targeted-final.log` |
| 最终 `npm --prefix runtime test` | 1864 项：1824 通过、35 跳过、5 失败 | `/tmp/lightmoni-alert-renewal-proposal-runtime-final.log`；失败集合与既有基线一致 |
| 最终 `npm run typecheck` | 通过 | `/tmp/lightmoni-alert-renewal-proposal-typecheck-final.log`；runtime、ai-runtime、web |
| 最终 `npm run build` | 通过 | `/tmp/lightmoni-alert-renewal-proposal-build-final.log`；仅有既有 Web 依赖警告 |
| Markdown 链接/代码围栏、`git diff --check`、秘密模式扫描 | 通过 | 无失效本地链接、空白错误或秘密模式 |

最终全量失败仅为 `agent-host-admission`、`machine-service-addresses`、`machine-terminal`、`managed-machines` 和 `node-lifecycle` 的既有用例，不宣称 runtime 全量通过。

## 行为与隔离 E2E 证据

- `incident.renew` 使用真实 Alerts/AlertProposalService，只有当前 acknowledged 事件的 owner 可以创建并完成；非 owner 和未接手事件失败关闭，管理员角色不绕过 owner。
- 原生续期已提取为 `Alerts.prepareRenew/commitRenew`，保留 handling_seconds/3600 秒、owner 和 renewed 审计语义。
- 审批后 handling_until 按原规则延长，generation 不变，事件仍 acknowledged；预览只标记将延期，实际期限以原生回执为准。
- 同 key 幂等、异输入冲突；有限 Host、成员、grant 撤销及 incidents.read Scope 缩小均失败关闭；预览/结果不包含 private evidence、联系人、payload 或供应商响应。
- 内部 `propose_alert_change` 使用同一原生提案和 commitRenew 路径，保持规则/静默及接手/转交/升级兼容。
- 隔离真实业务 E2E：官方 MCP 创建 incident.ack 并由管理员审批 → 创建 incident.renew 并由管理员审批 → 原事件 handling_until 更新 → MCP 回读。
- 工具总数保持 49；未新增直接 renew/Apply、通知重试或测试工具。

## 未验证与剩余范围

官方 MCP SDK 隔离 E2E 不等于真实 Codex/Claude OAuth、自然语言或生产环境验收；本轮未执行这些验证。通知重试、Agent 后续生命周期、服务回滚/核验、PR #208、Slice 4 和真实客户端矩阵仍需独立处理。

交付 PR：[workhold/lightmoni#212](https://github.com/workhold/lightmoni/pull/212)，目标为 main，依赖 #211；实现与验证完成，等待评审，未获本轮合并授权。
