# SDD 153 验证记录

验证日期：2026-11-14。范围为 Slice 3 中心受限工作区 SDK 插桩提案与稳定执行授权。分支基于已合入 SDD 152 的 `main@acc61ef`；未部署生产、未操作真实主机、未发布镜像。

## 自动化检查

| 检查 | 结果 | 覆盖 |
| --- | --- | --- |
| 全领域能力、插桩计划/Apply、官方 MCP 与权限定向测试 | 155/155 通过 | `/tmp/lightmoni-instrumentation-proposal-targeted-final.log` |
| 最终 `npm --prefix runtime test` | 1859 项：1819 通过、35 跳过、5 失败 | `/tmp/lightmoni-instrumentation-proposal-runtime-final.log`；失败集合与既有基线一致 |
| 最终 `npm run typecheck` | 通过 | `/tmp/lightmoni-instrumentation-proposal-typecheck-final.log`；runtime、ai-runtime、web |
| 最终 `npm run build` | 通过 | `/tmp/lightmoni-instrumentation-proposal-build-final.log`；仅有既有 Web 依赖警告 |
| Markdown 链接/代码围栏、`git diff --check`、秘密模式扫描 | 通过 | 无失效本地链接、空白错误或秘密模式 |

最终全量失败仅为 `agent-host-admission.test.ts`、`machine-service-addresses.test.ts`、`machine-terminal.test.ts`、`managed-machines.test.ts` 和 `node-lifecycle.test.ts` 的既有用例，与先前基线记录一致。不宣称 runtime 全量通过。

## 行为与隔离 E2E 证据

- 外部 `lightmoni_code_instrumentation_plan` 使用真实 InstrumentationService 和加密 SQLite Store，只创建 `awaiting_approval` 计划，工作区文件不变；MCP 返回摘要，管理员 review_url 返回完整 Diff 且不包含 before。
- 同 key 串行/并发返回原计划；request hash 包含能力版本、排除 base_revision，目标 revision 变化后的同 key 重试仍返回原计划，其他输入变化返回 `idempotency_conflict`。
- 外部加密计划、稳定 grant 和幂等记录在同一 SQLite 事务接受。强制幂等写入失败后，持久计划、授权绑定和内存缓存均无残留。
- code.workspace.propose 与 code.workspace.detail.read 必须同时存在；成员和有限 Host 被拒绝。撤销或无绑定外部计划 Apply 返回 `authorization_revoked`，文件不变。
- 内部 `propose_sdk_instrumentation` 统一 Dispatcher，返回原完整计划且不写外部 grant；原管理员 Apply 成功，未重复注册旧工具。
- 隔离真实业务 E2E：官方 MCP SDK 扫描并创建计划 → 原生管理员 HTTP Apply → 真实临时工作区文件发生预期插入 → 官方 MCP 回读 `applied`。该证据使用真实领域服务和文件系统，不是 mock 业务状态。
- 告警模块启用时工具总数由 49 增至 50；系统设计、接入文档和覆盖矩阵同步当前边界。

## 未验证与剩余范围

官方 MCP SDK 隔离 E2E 不等于真实 Codex/Claude OAuth、自然语言或生产环境验收；本轮未执行这些验证，也未验证修改后的业务项目构建/遥测。Apply/code_task 不作为模型工具开放；Agent 后续生命周期、服务回滚/核验、告警值班提案和 Slice 4 仍需独立切片。

交付 PR：[workhold/lightmoni#208](https://github.com/workhold/lightmoni/pull/208)，目标为 main；实现与验证完成，等待评审，未获本轮合并授权。
