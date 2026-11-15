# SDD 168 验证记录

原始验证日期：2026-11-14。范围为 Slice 5 的现有任务服务提案持续授权。原始分支基线为 `main@5076f64` + PR #218 `8ce9bca`，当时的 SDD 编号为 162/163；以下旧测试数量仅对应该基线。未部署生产、未操作真实主机、未发布镜像。

## 自动化检查

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| Capability、任务提案/调度、MCP、路由、安全及新增服务任务定向回归 | 212/212 通过 | `/tmp/lightmoni-service-task-targeted-final.log`；显式包含新测试文件 |
| `npm --prefix runtime test` | 1890 项：1850 通过、35 跳过、5 失败 | `/tmp/lightmoni-service-task-runtime-final.log`；失败集合与既有基线一致 |
| `npm --prefix ai-runtime test` | 71/71 通过 | `/tmp/lightmoni-service-task-ai-runtime.log` |
| `npm --prefix sdk/typescript test` | 28/28 通过 | `/tmp/lightmoni-service-task-sdk.log` |
| `npm run typecheck` | 通过 | runtime、ai-runtime、web |
| `npm run build` | 通过 | `/tmp/lightmoni-service-task-build-final.log`；仅有既有 Web 依赖警告 |
| Markdown 本地链接/代码围栏、`git diff --check`、秘密模式扫描 | 通过 | 无失效本地链接、空白错误或凭据模式 |

全量五项失败仅位于既有 `agent-host-admission`、`machine-service-addresses`、`machine-terminal`、`managed-machines` 和 `node-lifecycle` 用例，不宣称 runtime 全量通过。

## 行为证据

- 服务只能为固定 operation 的 `task.dispatch`、`run.cancel`、`run.retry` 创建原生提案；空操作规则、task.create/update、其他领域提案和越界 Host 均被拒绝。
- 原生 TaskProposalService 也校验服务 subject、Owner、能力证据与允许操作；beforeCreate 再次复验策略但不扣预算，不能通过绕过 Dispatcher 创建其他服务任务类型。
- 服务 ID 是提案业务 owner；Owner 管理员可读取/审批，其他管理员读取或审批为 404，服务自身直接 Apply 被拒绝。审批 actor、requested_by 与审计 actor 均为人类 Owner。
- 正常路径分别观察到 awaiting_approval、审批后的 queued、helper 领取后的 running 和真实结果回写后的 succeeded；提交预算只计一次，后续审批/领取不重复扣减。
- 提交后的策略漂移、撤销、到期和 Owner 降权均阻止审批且不创建 run；审批后的策略漂移或撤销使领取返回空，并将 run 标记为 `authorization_revoked`，不发放 lease。
- 自动重试保留 proposal_id、service ID 和 grant；撤销后在入队前关闭自动重试，正常路径可再次通过领取复验。旧表结构没有 proposal_id 时个人授权复制仍兼容，服务缺少证据则失败关闭。
- run.cancel/run.retry 均通过原生提案与人工审批，重试 run 绑定原服务提案。幂等重放返回同一提案，冲突与重放虽计为已接纳尝试，但只产生一个提案和一个 run。
- 现有 54 个工具、个人 PAT/OAuth、内部助手、Web 审批和任务调度回归保持兼容。

## 自审发现与修正

1. 扩大调度回归发现纯 TaskCenter/旧表结构没有 proposal_id 时直接复制新列会报错；已增加旧结构复制回退，并由原有外部重试用例和新增迁移用例验证。
2. 自审将允许操作和来源证据校验下沉到 TaskProposalService，并增加原生 beforeCreate continuation，避免仅依赖外部工具入口。
3. 检查测试日志发现通配符未覆盖新文件名，最终定向命令显式加入 `service-task-automation.test.ts`，确认 212 项包含全部 8 项新增测试。

## 未验证与剩余范围

- 未执行真实 Codex/Claude 客户端、真实 Agent、生产普通程序或生产业务 E2E；Dispatcher、原生服务与 helper fixture 只是开发证据。
- 不开放 task.create/update、周期计划、其他领域服务提案、直接 execute、任意脚本/Shell 或自动批准。
- 服务策略编辑/轮换、真实 Web 页面兼容矩阵、其他领域持续授权和完整平台真实业务闭环仍需后续独立 SDD。

原始交付 PR：[workhold/lightmoni#219](https://github.com/workhold/lightmoni/pull/219)，目标为 main，依赖 #218，合并顺序为 #218 → #219。2026-11-15 本地集成与回归结果另记于下节。

## 2026-11-15 主干集成回归

本地分支 `codex/219-integration-168` 从含 PR #226 的 `main@93dbe070` 和 #218 集成提交 `d11551fa` 出发，只移植 PR #219 的两笔功能/文档提交并解决 `docs/platform-mcp.md`、`docs/system-design.md` 冲突，随后对齐 #218 的 Doca 回读记录提交 `464469fd`。保留主干与 SDD 167 的设计记录，将本切片独立重编为 SDD 168；`docs/system-design.md` 第 14.4 节新增任务服务提案与持续复验两段，第 32 章更新服务主体边界，`docs/platform-mcp.md` 与 `docs/mcp.md` 同步当前能力说明。没有修改 #218 工作区。

| 检查 | 本地集成结果 |
| --- | --- |
| 9 个相关 Runtime 测试文件：服务主体、服务任务、任务提案/中心、MCP、Capability HTTP、助手任务 | 70 通过、0 失败 |
| Runtime、ai-runtime、Web `npm run typecheck` | 均通过 |
| Runtime、ai-runtime、Web `npm run build` | 均通过；Web 仅有第三方依赖的 `use client` 提示 |
| ai-runtime `npm test` | 79 通过、0 失败 |
| TypeScript SDK `npm test` | 28 通过、0 失败 |
| `git diff --check` | 通过 |

上述是本地受控回归，不等同真实客户端、Agent 或生产业务验收；本次未重跑 Runtime 全量，因此原始基线的 1890 项统计不作为新主干的全量结果。Doca 在线基线同步与最新版本文字、原生图节点/连线回读仍待完成；完成前不能宣称架构同步完成，也不推送或合并 #219。
