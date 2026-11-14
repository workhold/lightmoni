# SDD 147 验证记录

验证日期：2026-11-14。范围为 Slice 3 的任务 create/update 提案闭环。分支 stacked 在 SDD 146 的 `1ccbf35` 上；main 为 `a38e390`，PR #192～#200 在开发时均 OPEN 且未合并。未部署生产、未操作真实主机、未发布镜像。

交付 PR：[workhold/lightmoni#201](https://github.com/workhold/lightmoni/pull/201)，目标为 main，依赖 #192～#200；未合并。

## 自动化检查

| 检查 | 结果 | 覆盖 |
| --- | --- | --- |
| 全领域能力、真实任务/审批、MCP 与助手定向测试 | 290 项：288 通过、1 跳过、1 失败 | `/tmp/lightmoni-task-proposal-targeted.log`；唯一失败为 main 既有主机卸载断言 |
| `npm --prefix runtime test` | 1837 项：1797 通过、35 跳过、5 失败 | `/tmp/lightmoni-task-proposal-runtime-full.log`；失败集合与 main 基线一致 |
| `npm run typecheck` | 通过 | runtime、ai-runtime、web |
| `npm run build` | 通过 | `/tmp/lightmoni-task-proposal-build.log`；仅有既有 Web 依赖警告 |
| Markdown 链接、`git diff --check`、秘密模式扫描 | 通过 | 无失效链接、空白错误或秘密 |

## 行为证据

- 外部 create/update 均只保存 awaiting_approval；审批前任务定义不存在或不变，审批后由 NodeStore 完成且 Task Run 数为 0。
- 同 key 同输入返回原提案，异输入 idempotency_conflict；proposal 回读在审批后为 completed。
- 有限 Host 可创建授权内静态任务；其他 Host、target_all、标签和 before/after 越权均失败，撤销后待审批提案不能应用。
- 内部 propose_task_action 的 create/update 不再 fallback，source=assistant 且有 Dispatcher 审计；原任务调度、revision、owner 和 HTTP 审批回归通过。
- 官方 MCP SDK 完成 create→审批→update→审批→提案回读，无 apply/execute 工具。
- 工具总数保持 45；本次扩展现有 tasks.plan，而非新增万能工具。

## main 基线失败与未覆盖

最终全量仍只有 agent-host-admission、machine-service-addresses、machine-terminal、managed-machines、node-lifecycle 的 5 项既有失败；本切片没有新增失败，但不宣称 runtime 全量通过。

官方 MCP SDK 不等于真实 Codex/Claude OAuth 或自然语言验收；本切片未执行这些验证。告警、部署、运维、Agent、插桩和其他 Slice 3 提案仍需独立交付。
