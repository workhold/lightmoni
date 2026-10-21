# SDD 021：验证记录

> 记录截至 2026-10-22。验证结果覆盖中心部署状态/审批提案、受限 Agent job/executor、计划层和扫描切片，不代表真实业务部署或遥测闭环已经完成。

## 验收范围

本文件记录从规格到实现的可复核证据。本次切片实现了业务服务/目标/版本/部署计划元数据、中心状态迁移、管理员审批边界、脱敏部署事件和回滚提案、只读源码扫描、明确 TypeScript/JavaScript 请求边界的结构化插桩提案、管理员确认后的安全 apply、AI 计划工具、纯逻辑 systemd 适配器、Agent job/executor/runner 和中心侧有界验证判定；受控构建、真实主机 preflight、真实健康/遥测查询和业务 deployment 回执闭环仍待实现，不能把审批、job 入队或计划生成当作端到端部署完成。

## 规格与架构门

- [x] `spec.md` 定义 SDK 直连/Agent 模式、独立 Agent、源码插桩、部署适配器、审批、健康/遥测验证和回滚边界。
- [x] `plan.md` 定义 HLD/LLD 组件分层、数据模型、状态机、执行器和迁移策略。
- [x] `tasks.md` 将实现拆分为有依赖关系的任务，并标注当前状态。
- [x] `contracts/` 定义 HTTP/AI、适配器、Agent job 和插桩契约。
- [x] `docs/system-design.md` 已同步新增业务服务、SDK 扫描和适配器架构章节。
- [x] Doca 在线设计已写入并回读：在第 5 节加入业务部署流程原生流程图，确认节点和连线可见；当前图标注 Agent job/executor 已接入协议，真实健康/遥测验证和回滚闭环仍是目标能力。

## 功能验收矩阵

| 场景 | 预期 | 当前证据 | 状态 |
| --- | --- | --- | --- |
| Node/Python/Go/Rust 扫描 | 报告语言、框架、SDK 和候选位置，不执行项目代码 | `runtime/test/instrumentation.test.ts` | 通过（当前为启发式扫描） |
| 生成插桩 diff | 明确 TS/JS 多行请求边界逐文件生成摘要、unified diff、风险和验证命令；不自动写入；其他语言给手动步骤 | `runtime/test/instrumentation.test.ts`、`runtime/test/assistant-instrumentation-tools.test.ts` | 通过（受限提案） |
| 插桩 apply | 管理员确认、base revision、路径/符号链接/大小限制、原子写入和重复请求幂等 | `runtime/test/instrumentation.test.ts`、`runtime/src/assistant/index.ts` | 通过（本地 API/服务层；未执行构建） |
| revision 冲突 | apply 返回 409，不覆盖新修改 | `runtime/test/instrumentation.test.ts` | 通过 |
| 直连 SDK | 无 Agent 仍能上报中心 | 既有 SDK/接收测试 | 兼容性复核 |
| Agent SDK 模式 | Agent 本地持久化后用 data credential 上报 | 既有 Agent 队列；新闭环待复核 | 待验证 |
| systemd probe | 缺 unit/systemd/坏路径时结构化拒绝 | `runtime/test/deployment-adapter.test.ts` | 通过（纯计划层） |
| systemd plan | typed actions，禁止 shell | `runtime/test/deployment-adapter.test.ts` | 通过（纯计划层） |
| 服务/目标/版本/部署计划 | 管理员创建并生成 awaiting approval 计划 | `runtime/test/service-deployments.test.ts` | 通过（不执行） |
| 部署审批和状态迁移 | 已激活 Agent 才能由 awaiting approval 进入 agent_ready；非法状态拒绝 | `runtime/test/service-deployments.test.ts` | 通过（仅中心审批边界） |
| 部署事件时间线 | 计划/审批/回滚提案写入脱敏、按追加顺序可读事件 | `runtime/test/service-deployments.test.ts` | 通过 |
| AI 部署事件工具 | 管理员可读取脱敏状态时间线，不把事件当作主机执行回执 | `runtime/test/assistant-instrumentation-tools.test.ts` | 通过 |
| 回滚提案 | 已批准/失败部署可进入 rollback_pending，不执行主机动作 | `runtime/test/service-deployments.test.ts` | 通过（不执行） |
| AI 服务部署工具 | 结构化 ID 生成审核计划 | `runtime/src/assistant/tools.ts` + typecheck | 通过（不执行） |
| Agent staging | digest 核对、受控 release 目录和幂等 job | `runtime/src/agent/executor.ts`、`runtime/test/agent-executor.test.ts` | 通过（MVP typed actions；真实制品分发待接入） |
| 成功部署 | active/HTTP 健康、遥测查询通过 | `runtime/src/agent/executor.ts`、`runtime/src/deployment/verification.ts`（执行器和中心判定抽象）；真实 deployment 回执/查询待接入 | 部分通过（纯逻辑） |
| 遥测延迟 | 显示部署成功、遥测未验证，不误报失败 | `runtime/test/deployment-verification.test.ts` | 通过（有界证据；真实查询待接入） |
| 健康失败回滚 | 保留 Agent，切换 previous release | systemd 适配器 + deployment API；Agent 回执驱动回滚闭环待接入 | 待验证 |
| 恶意输入 | 路径、unit、URL、shell、过期签名均拒绝 | 安全负向测试待实现 | 待验证 |
| 权限和审批 | 只有管理员能 apply/build/approve/rollback | instrumentation apply API + service deployment API + `service-deployments.test.ts` | 部分通过（插桩 apply、approve/rollback；build 待实现） |
| 重试和未知结果 | operation/job 幂等；租约过期和 Agent 重启回报 unknown | `runtime/test/agent-jobs.test.ts` | 通过（真实 probe/补偿仍待后续） |

## 必跑检查

实现代码后，在仓库根目录运行与变更匹配的检查，并将完整命令和结果补入此处：

```bash
npm run typecheck --workspace runtime
npm test --workspace runtime -- --runInBand
npm run typecheck --workspace web
npm test --workspace web -- --runInBand
```

若 package script 名称不同，使用 `package.json` 中实际命令并记录替代原因。至少补充：

本次已运行：

- `npm --prefix runtime run typecheck`：通过。
- `npm --prefix runtime test`：254 tests，251 passed、3 skipped、0 failed。
- 插桩专用 `node --import tsx --test runtime/test/instrumentation.test.ts`：8 passed、0 failed；AI 工具专用 `node --import tsx --test runtime/test/assistant-instrumentation-tools.test.ts`：2 passed、0 failed；部署状态/迁移专用测试通过。
- `npm run typecheck`：runtime、ai-runtime、web 均通过。
- `git diff --check`：通过。

本轮新增验证：部署计划事件与状态变更在同一 SQLite 事务内写入；审批要求 Agent 最近 180 秒内心跳；回滚重复请求复用已持久化 operation ID；插桩提案支持传入扫描返回的 `base_revision` 并拒绝过期 revision；管理员 apply 原子写入并在重复请求时返回原始回执；AI 可读取脱敏部署事件时间线。

- deployment adapter unit tests（合法/非法路径、摘要、健康检查、rollback）及 service deployment 状态迁移/审批/事件测试；
- deployment verification tests（服务/实例归属、UTC 窗口、deadline、样本上限和健康但遥测未验证）；
- SQLite migration/repository 与 API 权限/幂等集成测试；
- Agent job claim/lease、事件幂等、结果、过期 unknown、重启 unknown、capability allow-list 和回执脱敏测试；`npm --prefix runtime exec tsx -- --test runtime/test/agent-jobs.test.ts runtime/test/agent-job-runner.test.ts runtime/test/agent-executor.test.ts`：5 passed、0 failed。
- scanner fixture、golden diff、revision conflict 和 secret 排除测试；
- 临时 systemd/mock executor 的成功、失败回滚、Agent 离线、遥测延迟端到端测试；
- `rg` 检查 token、密码、私钥和原始 SSH 输出没有进入源文件、日志样例、PR 或文档正文。

## 手工回归步骤

1. 建立一个只含测试服务的 workspace，运行扫描并确认没有读取 `.env` secret。
2. 生成插桩 diff，修改 workspace 后尝试 apply，确认 revision conflict；恢复后由管理员 apply 并核对 changed files。
3. 为目标机器登记 systemd unit，执行 SSH/Agent preflight；未激活 Agent 时确认 deployment approve 被拒绝。
4. 激活 Agent，创建 systemd plan，核对 typed actions、制品 digest、previous snapshot 和 review URL。
5. 管理员 approve，观察 Agent 事件和健康检查；用中心查询验证新 batch，核对 deployment timeline。
6. 用故意失败的 health check 触发 rollback，确认旧版本恢复且 Agent 仍心跳。
7. 模拟 Agent 断线/进程重启，确认状态为 unknown/重探测，不发生盲目重复 restart。
8. 在 Doca 写入前读取最新版本；保存后回读设计文本、流程图节点和边。图应包含源码 workspace、SDK 扫描/人工确认/构建、Agent preflight、systemd 计划、管理员批准、已接入的 Agent job/executor 协议以及待实现的真实验证/回滚边界。

## PR 发布前检查

- [x] 代码只在功能分支，目标为 `main`，没有直接推送主干。
- [x] SDD 任务状态和实现一致；未实现 provider 明确列在限制中。
- [x] `docs/system-design.md` 与 Doca 在同一 PR 同步；PR 描述列出仓库章节、Doca 链接、写入/回读结果。
- [ ] 管理员审批、secret 脱敏、SSH 清理提示和错误码均有 UI/AI 展示。
- [x] runtime typecheck 和相关部署/扫描测试通过；执行器和未知结果协议已实现，真实主机部署、健康/遥测查询及业务状态闭环仍明确标为未实现。
- [x] PR #25 已创建并保持待审核；未经用户明确授权不合并。
