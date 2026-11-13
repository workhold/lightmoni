# SDD 150 验证记录

验证日期：2026-11-14。范围为 Slice 3 既有运维资源动作提案与稳定执行授权。分支 stacked 在 SDD 149 的 `64db6a0` 上；开发及提交前 `origin/main` 均为 `a38e390`，PR #192～#203 均 OPEN 且未合并。未部署生产、未操作真实主机、未发布镜像。

## 自动化检查

| 检查 | 结果 | 覆盖 |
| --- | --- | --- |
| 全领域能力、运维计划/审批/SSH、MCP 与权限定向测试 | 145/145 通过 | `/tmp/lightmoni-operation-proposal-targeted.log` |
| 最终 `npm --prefix runtime test` | 1849 项：1809 通过、35 跳过、5 失败 | `/tmp/lightmoni-operation-proposal-runtime-final.log`；失败集合与既有基线一致 |
| 最终 `npm run typecheck` | 通过 | `/tmp/lightmoni-operation-proposal-typecheck-final.log`；runtime、ai-runtime、web |
| 最终 `npm run build` | 通过 | `/tmp/lightmoni-operation-proposal-build-final.log`；仅有既有 Web 依赖警告 |
| Markdown 链接/代码围栏、`git diff --check`、秘密模式扫描 | 通过 | 无失效本地链接、空白错误或秘密模式 |

最终全量失败仅为 `agent-host-admission.test.ts`、`machine-service-addresses.test.ts`、`machine-terminal.test.ts`、`managed-machines.test.ts` 和 `node-lifecycle.test.ts` 的既有用例；`/tmp/lightmoni-baseline-*.log` 与 SDD 149 记录提供基线对照。不宣称 runtime 全量通过。

## 行为证据

- 外部 `lightmoni_operations_plan` 使用真实 OperationsStore，仅创建 `awaiting_approval` Run，未创建 Agent Job；响应只含 proposal 与安全 runMetadata，不包含网站正文或 preview。
- 同 key 同输入返回原 Run 并标记幂等命中，异输入返回 `idempotency_conflict`；创建、外部 grant 绑定和幂等记录处于同一 SQLite 事务。
- `operations.propose` 与 `operations.read` 必须同时存在；有限 Host 和成员不能调用。外部绑定使用 `domain=operation`、`native_id=ops_runs.id`。
- 撤销后原生审批抛出 `authorization_revoked`，Run 保持待审批且 Job 数为 0；已审批但未开始的 privileged Job 在中心 SSH 获取主机租约前失败关闭，Receipt 保留授权撤销原因。
- 未配置 ExecutionGrantRegistry 的旧 SSH fixture 不做关联查询；既有中心 SSH、运维 API、部署授权及 MCP 权限测试通过。
- 内部 `propose_operations_action` 通过 Dispatcher，隐藏内部自动 reason/idempotency，保持 `{run}` 响应且不写外部 grant；实际助手注册无重复工具。
- 官方 MCP SDK 完成工具发现、计划创建、原管理员审批和 queued Run 回读；无审批、直接执行、取消、触发或 Schedule 写工具。
- 告警模块启用时工具总数由 47 增至 48；Slice 2 覆盖矩阵和系统设计均记录当前边界。

## 未验证与剩余范围

官方 MCP SDK 自动化不等于真实 Codex/Claude OAuth 或自然语言验收；本轮未执行这些验证，也未执行真实主机/生产环境验证。运维资源创建/修改/删除、MCP 审批、取消、手动触发、Schedule 写入、直接执行、回滚、Agent 生命周期和插桩写入仍需独立切片。

交付状态：实现与验证完成，等待 PR 评审；未获本轮合并授权，不自动合并。
