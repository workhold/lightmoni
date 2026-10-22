# SDD 021：验证记录

> 记录截至 2026-10-22。验证结果覆盖中心部署状态/审批、Agent 回执闭环、受限 job/executor、计划层和扫描切片，不代表真实业务部署或遥测闭环已经完成。

## 验收范围

本文件记录从规格到实现的可复核证据。本次切片实现了业务服务/目标/版本/部署计划元数据、中心状态迁移、管理员审批边界、脱敏部署事件和回滚提案、Agent 回执驱动状态映射、只读源码扫描、明确 TypeScript/JavaScript 请求边界的结构化插桩提案、管理员确认后的安全 apply、AI 计划工具、纯逻辑 systemd 适配器、Agent job/executor/runner 和中心侧有界验证判定；受控构建、真实主机 preflight、中心 ClickHouse 遥测验证和业务自动回滚仍待实现，不能把审批、job 入队或 Agent 健康回执当作端到端部署完成。

## 规格与架构门

- [x] `spec.md` 定义 SDK 直连/Agent 模式、独立 Agent、源码插桩、部署适配器、审批、健康/遥测验证和回滚边界。
- [x] `plan.md` 定义 HLD/LLD 组件分层、数据模型、状态机、执行器和迁移策略。
- [x] `tasks.md` 将实现拆分为有依赖关系的任务，并标注当前状态。
- [x] `contracts/` 定义 HTTP/AI、适配器、Agent job 和插桩契约。
- [x] `docs/system-design.md` 已更新本轮 Agent job → 部署状态控制路径、健康回执边界和 Mermaid 时序图。
- [ ] Doca 基线图此前已同步；本轮状态回执控制路径增量尚未同步。浏览器打开目标时返回“资源不存在或无权访问”，因此不能标记完成，PR 发布门待恢复访问后回读文本、节点和连线。

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
| 部署审批和状态迁移 | 已激活 Agent 且计划含授权 health_check 才能入队；Agent 有序阶段和最终健康回执推进状态 | `runtime/test/service-deployments.test.ts` | 通过（不代表真实主机部署） |
| 部署事件时间线 | 计划/审批/Agent 阶段/终态/回滚提案写入脱敏、按追加顺序可读事件 | `runtime/test/service-deployments.test.ts` | 通过 |
| Agent 事件顺序 | event 序号连续、重复请求幂等、阶段不能回退/跳跃；终态 event 不替代最终 result | `runtime/test/agent-jobs.test.ts` | 通过 |
| 取消和未知结果 | 仅未领取任务可安全取消；领取后取消、租约过期和不完整成功回执保留 unknown | `runtime/test/agent-jobs.test.ts`、`runtime/test/service-deployments.test.ts` | 通过 |
| 中心过期扫描 | Agent 离线后无需再请求，后台即可将租约过期任务转 unknown，并取消未领取的过期 job | `runtime/test/agent-jobs.test.ts` | 通过 |
| AI 部署事件工具 | 管理员可读取脱敏状态时间线，不把事件当作主机执行回执 | `runtime/test/assistant-instrumentation-tools.test.ts` | 通过 |
| 回滚提案 | 已批准/失败部署可进入 rollback_pending，不执行主机动作 | `runtime/test/service-deployments.test.ts` | 通过（不执行） |
| AI 服务部署工具 | 结构化 ID 生成审核计划 | `runtime/src/assistant/tools.ts` + typecheck | 通过（不执行） |
| Agent staging | digest 核对、受控 release 目录和幂等 job | `runtime/src/agent/executor.ts`、`runtime/test/agent-executor.test.ts` | 通过（MVP typed actions；真实制品分发待接入） |
| Agent 健康成功 | 计划含授权 health_check 且最终结果有 `health.healthy=true` 后才进入 succeeded | `runtime/src/agent/executor.ts`、`runtime/src/server/agent-jobs.ts`、`runtime/test/service-deployments.test.ts` | 通过（不代表中心遥测已验证） |
| 中心遥测验证 | 业务部署后查询 ClickHouse 核对新遥测 | `runtime/src/deployment/verification.ts`（仅有界判定器） | 待实现 |
| 部署状态可读性 | 中文/英文显示各阶段；unknown 提示人工检查；成功文案说明遥测未验证 | `web/src/app/ServiceDeploymentsPage.tsx`、根目录 `npm run typecheck` | 通过 |
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
- `npm --prefix runtime test`：256 tests，253 passed、3 skipped、0 failed。
- `npm test`（根目录）：runtime 256 tests（253 passed、3 skipped）、ai-runtime 71 passed、TypeScript SDK 18 passed；0 failed。
- 插桩专用 `node --import tsx --test runtime/test/instrumentation.test.ts`：8 passed、0 failed；AI 工具专用 `node --import tsx --test runtime/test/assistant-instrumentation-tools.test.ts`：2 passed、0 failed；部署状态/迁移专用测试通过。
- `npm run typecheck`：runtime、ai-runtime、web 均通过。
- `git diff --check`：通过。
- `web/src/app/ServiceDeploymentsPage.tsx` 状态双语文案和 unknown/遥测提示已通过 web TypeScript 检查。
- `npm --prefix web run build`：通过，产物打包成功；依赖中的 `use client` 指令有现存 bundler warning。

本轮新增验证：Agent 阶段回执与部署状态/时间线在同一 SQLite 事务内写入；管理员取消或过期的未领取 job 可安全终止，已领取 job 取消/超时保留 unknown，中心定时扫描不依赖 Agent 再次请求；事件序号连续、阶段单调且拒绝跳跃/回退；审批要求计划含 capability 授权的 health_check；只有 verifying 后且最终 `health.healthy=true` 才能进入 succeeded；缺少证据的成功回执被转成 unknown；秘密和原始快照不会进入部署详情/时间线。

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
- [ ] `docs/system-design.md` 已在本轮更新；Doca 本轮增量因目标页面显示“资源不存在或无权访问”未完成，恢复访问并完成回读前不能关闭此发布门。
- [ ] 管理员审批、secret 脱敏、SSH 清理提示和错误码均有 UI/AI 展示。
- [x] 根目录 `npm test` 和 `npm run typecheck` 通过；Agent receipt 状态映射已实现，真实主机 preflight、构建/制品分发、中心遥测验证及最终回滚仍明确标为未实现。
- [x] PR #25 已创建并保持待审核；未经用户明确授权不合并。
