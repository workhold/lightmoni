# SDD 151 验证记录

验证日期：2026-11-14。范围为 Slice 3 Agent 首装提案与稳定执行授权。分支 stacked 在 SDD 150 的 `c248c0f` 上；开发初 `origin/main` 为 `a38e390`，提交前已无冲突同步 `411ed75`；PR #192～#204 未合并。未部署生产、未操作真实主机、未发布镜像；SSH/安装测试均使用隔离 fixture。

## 自动化检查

| 检查 | 结果 | 覆盖 |
| --- | --- | --- |
| 全领域能力、Agent 计划/Apply、MCP 与权限定向测试 | 150/150 通过 | `/tmp/lightmoni-agent-installation-proposal-targeted-final.log` |
| 真实 ManagedMachineStore、安装恢复和权限组合回归 | 120 项：119 通过、1 个既有失败 | 唯一失败为 `managed-machines` 基线用例；新增测试全部通过 |
| 最终 `npm --prefix runtime test` | 1854 项：1814 通过、35 跳过、5 失败 | `/tmp/lightmoni-agent-installation-proposal-runtime-final.log`；失败集合与既有基线一致 |
| 最终 `npm run typecheck` | 通过 | `/tmp/lightmoni-agent-installation-proposal-typecheck-final.log`；runtime、ai-runtime、web |
| 最终 `npm run build` | 通过 | `/tmp/lightmoni-agent-installation-proposal-build-final.log`；仅有既有 Web 依赖警告 |
| Markdown 链接/代码围栏、`git diff --check`、秘密模式扫描 | 通过 | 无失效本地链接、空白错误或秘密模式 |

最终全量失败仅为 `agent-host-admission.test.ts`、`machine-service-addresses.test.ts`、`machine-terminal.test.ts`、`managed-machines.test.ts` 和 `node-lifecycle.test.ts` 的既有用例，与先前基线记录一致。不宣称 runtime 全量通过。

## 行为证据

- 外部 `lightmoni_agent_installations_plan` 使用真实 ManagedMachineStore 和成功 fresh check_id，只创建 `awaiting_approval` 的 machine_deployments 计划；预检后没有新增 SSH、enrollment 或安装动作。
- 返回原生相对 plan review_url 和绝对 proposal review_url；同 key 幂等回放，省略或显式 root/空标签的规范化输入一致，异输入返回 `idempotency_conflict`。
- 外部计划、稳定 grant 和幂等记录处于同一 SQLite 事务，domain=agent_installation、native_id=machine_deployments.id。
- agents.maintain.propose 与 agents.read 必须同时存在；成员和错误主机授权被拒绝，具有目标主机范围的管理员可以创建计划。
- grant 撤销或主机范围缩小后，原管理员 Apply 返回 `authorization_revoked`，计划保持待审批，未签发 enrollment、未执行安装 SSH。
- 内部 `propose_agent_install` 统一 Dispatcher，保持原计划/review_url 返回结构且不写外部 grant；实际助手注册无重复工具。
- 官方 MCP SDK 完成计划工具发现、计划创建、稳定 grant 关联和原生状态读取；无 approve/apply/execute 工具。
- 告警模块启用时工具总数由 48 增至 49；系统设计、接入文档和覆盖矩阵均记录当前边界。

## 未验证与剩余范围

官方 MCP SDK 自动化不等于真实 Codex/Claude OAuth 或自然语言验收；本轮未执行这些验证，也未执行真实主机安装。Agent SSH 预检、直接安装、审批、恢复、升级、回滚和卸载仍未开放；服务回滚/核验、制品、插桩写入和 code_task 需独立切片。

交付 PR：[workhold/lightmoni#206](https://github.com/workhold/lightmoni/pull/206)，目标为 main，依赖 #192～#204；实现与验证完成，等待评审，未获本轮合并授权。
