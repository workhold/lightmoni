# SDD 140 验证记录

验证日期：2026-11-14。范围为 Slice 2 运维与计划任务只读。分支 stacked 在 SDD 139 的 `2994d1b` 上；main 为 `1c3b0e4`，PR #192/#193 在开发时均 OPEN 且未合并。未部署生产、未操作真实主机、未发布镜像。

## 自动化检查

| 检查 | 结果 | 覆盖 |
| --- | --- | --- |
| 全领域能力、原/新运维、Schedule、MCP 与助手定向测试 | 171 项：170 通过、1 跳过、0 失败 | `/tmp/lightmoni-operation-targeted.log`；跳过为既有 backup source 限制用例 |
| `npm --prefix runtime test` | 1817 项：1777 通过、35 跳过、5 失败 | `/tmp/lightmoni-operation-runtime-full.log`；失败集合与 main 基线一致 |
| `npm run typecheck` | 通过 | runtime、ai-runtime、web |
| `npm run build` | 通过 | `/tmp/lightmoni-operation-build.log`；仅有既有 Web 依赖警告 |
| Markdown 链接、`git diff --check`、秘密模式扫描 | 通过 | 无失效本地链接、空白错误、真实令牌或私钥 |

## 行为证据

- 资源列表/详情使用真实 OperationsStore；网站 static_files 正文被安全摘要替代，private-body 不进入结果。
- Run 列表仅原元数据，不含 preview；Run 详情保留 awaiting_approval，敏感投影和原 28 KiB 规则不变。
- Schedule 列表/详情来自真实 Schedule Store，详情包含真实 fires 空数组、operation、cron 和授权状态。
- 无 operations.read、有限主机或成员不能发现/调用；直接 invoke 仍拒绝。
- 内部两个旧工具和四个新读取工具均由 Dispatcher 适配，注册无重复；propose_operations_action 仍只读原元数据且不对外。
- 官方 MCP SDK 发现六个新能力，读取资源、Run 和 Schedule，无 approve/delete/execute/trigger 工具。
- 告警模块启用时工具总数为 31。

## main 基线失败与未覆盖

最终全量仍只有 agent-host-admission、machine-service-addresses、machine-terminal、managed-machines、node-lifecycle 的 5 项既有失败；本切片没有新增失败，但不宣称 runtime 全量通过。

官方 MCP SDK 不等于真实 Codex/Claude OAuth 或自然语言验收；本切片未执行这些验证。运维提案/审批/取消/手动触发/Schedule 写入属于 Slice 3，主机/Agent 和其他领域仍待迁移。
