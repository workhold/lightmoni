# SDD 149 验证记录

验证日期：2026-11-14。范围为 Slice 3 服务部署提案与稳定执行授权。分支 stacked 在 SDD 148 的 `bef0c7c` 上；main 为 `a38e390`，PR #192～#202 在开发时均 OPEN 且未合并。未部署生产、未操作真实主机、未发布镜像。

## 自动化检查

| 检查 | 结果 | 覆盖 |
| --- | --- | --- |
| 全领域能力、部署计划/审批/SSH、MCP 与助手定向测试 | 297 项：295 通过、1 跳过、1 失败 | `/tmp/lightmoni-deployment-proposal-targeted.log`；唯一失败为 main 既有主机卸载断言 |
| `npm --prefix runtime test` | 1844 项：1804 通过、35 跳过、5 失败 | `/tmp/lightmoni-deployment-proposal-runtime-final.log`；失败集合与 main 基线一致 |
| 原中心 SSH + 部署授权组合复验 | 10/10 通过 | 覆盖旧 SSH 行为与新授权围栏 |
| `npm run typecheck` | 通过 | runtime、ai-runtime、web |
| `npm run build` | 通过 | `/tmp/lightmoni-deployment-proposal-build.log`；仅有既有 Web 依赖警告 |
| Markdown 链接、`git diff --check`、秘密模式扫描 | 通过 | 无失效链接、空白错误或秘密 |

## 行为证据

- 外部部署计划使用真实 ServiceDeploymentStore，保持 awaiting_approval，未创建 Agent Job；同 key 回放返回原计划，异输入 idempotency_conflict。
- ExecutionGrantRegistry 保存 deployment/grant/user/source/reason；同 ID 不覆盖。撤销后 assert 返回 authorization_revoked。
- 审批 HTTP 在撤销时返回 403，部署仍 awaiting_approval且 Job 数为 0；已排队且有外部绑定的 ordinary Job 在 SSH 领取前失败为 authorization_revoked，未获取主机租约。
- deployments.propose/read 必须同时存在，有限 Host 和成员不能调用；内部无绑定计划不受影响。
- 内部 propose_service_deployment 使用 Dispatcher，返回原 plan 且不写外部授权绑定；审计 source=assistant。
- 官方 MCP SDK 创建部署计划并验证原生状态和 grant 关联，无 rollback/cancel/upload/approve/execute 工具。
- 告警模块启用时工具总数为 47。

## 中间问题与最终边界

初次实现曾对未配置 Registry 的旧 SSH fixture 也执行关联查询，产生 3 项中间失败。已修正为仅在配置 ExecutionGrantRegistry 时查询/复验；原中心 SSH 6 项与部署授权 4 项组合测试通过，最终全量不包含这些新增失败。中间日志不作为最终证据。

最终全量仍只有 agent-host-admission、machine-service-addresses、machine-terminal、managed-machines、node-lifecycle 的 5 项 main 既有失败，不宣称 runtime 全量通过。官方 MCP SDK 不等于真实 Codex/Claude OAuth 或自然语言验收；未执行这些验证。回滚、取消、上传、核验写入和其他 Slice 3 提案仍需独立完成。
