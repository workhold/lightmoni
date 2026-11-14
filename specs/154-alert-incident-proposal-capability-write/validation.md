# SDD 154 验证记录

验证日期：2026-11-14。范围为 Slice 3 告警事件接手提案与原生执行。分支基于 `main@acc61ef`；PR #208 仍 OPEN、未合入。未部署生产、未操作真实主机、未发布镜像。

## 自动化检查

| 检查 | 结果 | 覆盖 |
| --- | --- | --- |
| 全领域能力、告警计划/审批、官方 MCP 与权限定向测试 | 154/154 通过 | `/tmp/lightmoni-alert-incident-proposal-targeted-final.log` |
| 最终 `npm --prefix runtime test` | 1858 项：1817 通过、35 跳过、6 失败 | `/tmp/lightmoni-alert-incident-proposal-runtime-final.log`；5 个既有基线失败 + 1 个 loopback SSH 瞬时失败 |
| 瞬时失败单独复验 | `machine-ssh-discovery.test.ts` 12/12 通过 | 全量超时后独立复验通过，不据此宣称全量通过 |
| 最终 `npm run typecheck` | 通过 | `/tmp/lightmoni-alert-incident-proposal-typecheck-final.log`；runtime、ai-runtime、web |
| 最终 `npm run build` | 通过 | `/tmp/lightmoni-alert-incident-proposal-build-final.log`；仅有既有 Web 依赖警告 |
| Markdown 链接/代码围栏、`git diff --check`、秘密模式扫描 | 通过 | 无失效本地链接、空白错误或秘密模式 |

五个既有失败为 `agent-host-admission`、`machine-service-addresses`、`machine-terminal`、`managed-machines` 和 `node-lifecycle`。额外失败为 `machine-ssh-discovery` 的 loopback 超时，独立复验通过；最终报告保留全部失败事实。

## 行为与隔离 E2E 证据

- `incident.ack` 使用真实 Alerts/AlertProposalService，只创建 `awaiting_approval`，原事件保持 firing；预览 after 不被当成已接手。
- 原生 `acknowledge` 拆为只读 `prepareAcknowledge` 与同步 `commitAcknowledge`，保留规则 revision、责任组成员、响应 generation 和通知取消语义；现有规则/静默回归通过。
- 审批后原 SQLite 事务把事件更新为 acknowledged、owner=admin；结果和预览不包含 private evidence、联系人、payload 或供应商响应。
- 同 key 幂等、异输入冲突；缺 `alerts.incidents.read`、有限 Host、成员、grant 撤销及审批前 Scope 缩小均失败关闭。规则变化使旧提案失效且不完成审批。
- `lightmoni_alerts_plan` 返回受保护 review_url；内部 `propose_alert_change` 使用同一原提案/Apply 路径，保持既有规则/静默兼容。
- 隔离真实业务 E2E：官方 MCP SDK 创建 incident.ack 提案 → 原管理员 HTTP Apply → 原 Alerts 响应变为 acknowledged → 官方 MCP 回读真实事件。
- 工具总数保持 49；未新增直接 ack/Apply、转交、升级、续期、通知重试或测试工具。

## 未验证与剩余范围

官方 MCP SDK 隔离 E2E 不等于真实 Codex/Claude OAuth、自然语言或生产环境验收；本轮未执行这些验证。其他值班动作、Agent 后续生命周期、服务回滚/核验、SDD 153 插桩 PR 和 Slice 4 仍需独立处理。

交付状态：实现与验证完成，等待 PR 评审；未获本轮合并授权，不自动合并。
