# SDD 146 验证记录

验证日期：2026-11-14。范围为告警响应统计与 Slice 2 覆盖审计。分支 stacked 在 SDD 145 的 `ca580f1` 上；main 为 `a38e390`，PR #192～#199 在开发时均 OPEN 且未合并。未部署生产、未操作真实主机、未发布镜像。

## 自动化检查

| 检查 | 结果 | 覆盖 |
| --- | --- | --- |
| 全领域能力、原/新告警统计、MCP 与助手定向测试 | 286 项：284 通过、1 跳过、1 失败 | `/tmp/lightmoni-alert-statistics-targeted.log`；唯一失败为 main 既有主机卸载断言 |
| `npm --prefix runtime test` | 1833 项：1793 通过、35 跳过、5 失败 | `/tmp/lightmoni-alert-statistics-runtime-full.log`；失败集合与 main 基线一致 |
| `npm run typecheck` | 通过 | runtime、ai-runtime、web |
| `npm run build` | 通过 | `/tmp/lightmoni-alert-statistics-build.log`；仅有既有 Web 依赖警告 |
| Markdown 链接、`git diff --check`、秘密模式扫描 | 通过 | 含 coverage.md；无失效链接、空白错误或秘密 |

## 行为证据

- responseStatistics 与原 HTTP 共用 AlertReadService；真实 assignment 产生 notified=1、acknowledged=1、ack_rate=100、mean/median/p95=60 秒和一条记录。
- 原 response-statistics/domains 回归通过；默认窗口、筛选、零成员、20000 上限和定义文本未改变。
- alerts.statistics.read 与 incidents/notifications Scope 独立；有限主机和外部成员未获权限，内部成员适配器可读取。
- 内部 get_alert_response_statistics 使用 Dispatcher，审计 source=assistant；官方 MCP SDK 发现并调用统计。
- coverage.md 明确已统一只读领域及后续提案、远程探针、长代码任务、恢复/卸载、服务主体与真实客户端验证边界。
- 告警模块启用时工具总数为 45；没有新增写或执行工具。

## main 基线失败与未覆盖

最终全量仍只有 agent-host-admission、machine-service-addresses、machine-terminal、managed-machines、node-lifecycle 的 5 项既有失败；本切片没有新增失败，但不宣称 runtime 全量通过。

官方 MCP SDK 不等于真实 Codex/Claude OAuth 或自然语言验收；本切片未执行这些验证。Slice 3/4/5 及覆盖矩阵所列后续工作均未完成，不能宣布整个 Goal 完成。
