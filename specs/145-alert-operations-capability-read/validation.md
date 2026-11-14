# SDD 145 验证记录

验证日期：2026-11-14。范围为 Slice 2 审计补齐的告警事件与通知只读。分支 stacked 在 SDD 144 的 `85e55b4` 上；main 为 `a38e390`，PR #192～#198 在开发时均 OPEN 且未合并。未部署生产、未操作真实主机、未发布镜像。

交付 PR：[workhold/lightmoni#199](https://github.com/workhold/lightmoni/pull/199)，目标为 main，依赖 #192～#198；未合并。

## 自动化检查

| 检查 | 结果 | 覆盖 |
| --- | --- | --- |
| 全领域能力、原/新告警、真实事件/Outbox、MCP 与助手定向测试 | 285 项：283 通过、1 跳过、1 失败 | `/tmp/lightmoni-alert-operations-targeted.log`；唯一失败为 main 既有主机卸载断言 |
| `npm --prefix runtime test` | 1832 项：1792 通过、35 跳过、5 失败 | `/tmp/lightmoni-alert-operations-runtime-full.log`；失败集合与 main 基线一致 |
| `npm run typecheck` | 通过 | runtime、ai-runtime、web |
| `npm run build` | 通过 | `/tmp/lightmoni-alert-operations-build.log`；仅有既有 Web 依赖警告 |
| Markdown 链接、`git diff --check`、秘密模式扫描 | 通过 | 无失效本地链接、空白错误、真实令牌或私钥 |

## 行为证据

- AlertReadService 与原 Alert incidents/deliveries API 共用筛选；原 API、domains 和通知回归通过。
- 事件列表无 evidence，详情保留真实 incident 和一条时间线；不存在对象按原边界拒绝。
- 通知投递保留 failed 状态和 error_present；private-contact/private-response/private-payload/raw error 均不进入结果。
- incidents/notifications Scope 相互独立，有限主机不能发现/调用；成员内部读取保持，外部权限未扩大。
- 内部三个新工具由 Dispatcher 提供，注册无重复，审计 source=assistant；无接手/确认/分配/重试/测试工具。
- 官方 MCP SDK 发现并调用事件列表、事件详情和投递列表，outputSchema 校验通过。
- 告警模块启用时工具总数为 44。

## main 基线失败与未覆盖

最终全量仍只有 agent-host-admission、machine-service-addresses、machine-terminal、managed-machines、node-lifecycle 的 5 项既有失败；本切片没有新增失败，但不宣称 runtime 全量通过。

官方 MCP SDK 不等于真实 Codex/Claude OAuth 或自然语言验收；本切片未执行这些验证。响应统计、通知渠道配置和所有写操作仍未开放。
