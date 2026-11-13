# SDD 148 验证记录

验证日期：2026-11-14。范围为 Slice 3 告警规则与静默提案闭环。分支 stacked 在 SDD 147 的 `3054f33` 上；main 为 `a38e390`，PR #192～#201 在开发时均 OPEN 且未合并。未部署生产、未操作真实主机、未发布镜像。

## 自动化检查

| 检查 | 结果 | 覆盖 |
| --- | --- | --- |
| 全领域能力、原/新告警提案、MCP 与助手定向测试 | 293 项：291 通过、1 跳过、1 失败 | `/tmp/lightmoni-alert-proposal-targeted.log`；唯一失败为 main 既有主机卸载断言 |
| `npm --prefix runtime test` | 1840 项：1800 通过、35 跳过、5 失败 | `/tmp/lightmoni-alert-proposal-runtime-full.log`；失败集合与 main 基线一致 |
| `npm run typecheck` | 通过 | runtime、ai-runtime、web |
| `npm run build` | 通过 | `/tmp/lightmoni-alert-proposal-build.log`；仅有既有 Web 依赖警告 |
| Markdown 链接、`git diff --check`、秘密模式扫描 | 通过 | 无失效链接、空白错误或秘密 |

## 行为证据

- 外部规则/静默提案保持 awaiting_approval，审批前规则不变；审批后由原 AlertCapabilities 更新并读取真实回执。
- 外部 proposal.session_id 为空，owner/加密 before/after 与原 15 分钟期限不变；内部仍绑定真实 session。
- 同 key 同输入及并发请求只产生一个提案，异输入 idempotency_conflict；撤销后待审批提案失败且不修改配置。
- alerts.propose 与 alerts.detail.read 必须同时存在，有限 Host 和成员不获得该写提案能力；直接 invoke 不绕过。
- 内部 propose_alert_change 改走 Dispatcher，原真实 Mastra/HTTP 审批回归通过。
- 官方 MCP SDK 完成规则提案、人工审批和 completed 回读，无 apply/approve 工具。
- 告警模块启用时工具总数为 46。

## main 基线失败与未覆盖

最终全量仍只有 agent-host-admission、machine-service-addresses、machine-terminal、managed-machines、node-lifecycle 的 5 项既有失败；本切片没有新增失败，但不宣称 runtime 全量通过。

官方 MCP SDK 不等于真实 Codex/Claude OAuth 或自然语言验收；本切片未执行这些验证。事件接手、通知、部署、运维、Agent、插桩和其他 Slice 3 提案仍需独立交付。
