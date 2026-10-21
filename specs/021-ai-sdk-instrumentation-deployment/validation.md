# SDD 021：验证记录

> 记录截至 2026-10-21。验证结果只覆盖本次计划层/扫描切片，不代表 Agent 执行、真实部署或遥测闭环已经完成。

## 验收范围

本文件记录从规格到实现的可复核证据。本次切片实现了业务服务/目标/版本/部署计划元数据、只读源码扫描、AI 计划工具和纯逻辑 systemd 适配器；Agent job executor、受控构建、自动插桩补丁和遥测验证仍待实现，不能把计划生成当作端到端部署完成。

## 规格与架构门

- [x] `spec.md` 定义 SDK 直连/Agent 模式、独立 Agent、源码插桩、部署适配器、审批、健康/遥测验证和回滚边界。
- [x] `plan.md` 定义 HLD/LLD 组件分层、数据模型、状态机、执行器和迁移策略。
- [x] `tasks.md` 将实现拆分为有依赖关系的任务，并标注当前状态。
- [x] `contracts/` 定义 HTTP/AI、适配器、Agent job 和插桩契约。
- [x] `docs/system-design.md` 已同步新增业务服务、SDK 扫描和适配器架构章节。
- [x] Doca 在线设计已写入并回读：在第 5 节加入业务部署流程原生流程图，确认节点和连线可见；当前图明确标注 Agent executor、健康/遥测验证和回滚仍是目标能力。

## 功能验收矩阵

| 场景 | 预期 | 当前证据 | 状态 |
| --- | --- | --- | --- |
| Node/Python/Go/Rust 扫描 | 报告语言、框架、SDK 和候选位置，不执行项目代码 | `runtime/test/instrumentation.test.ts` | 通过（当前为启发式扫描） |
| 生成插桩 diff | 逐文件摘要、风险和验证命令；不自动写入 | instrumentation plan 待实现 | 待验证 |
| revision 冲突 | apply 返回 409，不覆盖新修改 | API 测试待实现 | 待验证 |
| 直连 SDK | 无 Agent 仍能上报中心 | 既有 SDK/接收测试 | 兼容性复核 |
| Agent SDK 模式 | Agent 本地持久化后用 data credential 上报 | 既有 Agent 队列；新闭环待复核 | 待验证 |
| systemd probe | 缺 unit/systemd/坏路径时结构化拒绝 | `runtime/test/deployment-adapter.test.ts` | 通过（纯计划层） |
| systemd plan | typed actions，禁止 shell | `runtime/test/deployment-adapter.test.ts` | 通过（纯计划层） |
| 服务/目标/版本/部署计划 | 管理员创建并生成 awaiting approval 计划 | `runtime/test/service-deployments.test.ts` | 通过（不执行） |
| AI 服务部署工具 | 结构化 ID 生成审核计划 | `runtime/src/assistant/tools.ts` + typecheck | 通过（不执行） |
| Agent staging | digest 核对、受控 release 目录和幂等 job | executor 待实现 | 待验证 |
| 成功部署 | active/HTTP 健康、遥测查询通过 | deployment API/验证待实现 | 待验证 |
| 遥测延迟 | 显示部署成功、遥测未验证，不误报失败 | 遥测验证待实现 | 待验证 |
| 健康失败回滚 | 保留 Agent，切换 previous release | executor/回滚 API 待实现 | 待验证 |
| 恶意输入 | 路径、unit、URL、shell、过期签名均拒绝 | 安全负向测试待实现 | 待验证 |
| 权限和审批 | 只有管理员能 apply/build/approve/rollback | API/AI 工具待实现 | 待验证 |
| 重试和未知结果 | operation/job 幂等；重启后先 probe | Agent job 协议待实现 | 待验证 |

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
- `npm --prefix runtime test`：232 passed、3 skipped、0 failed（共 235 个测试）。
- `npm run typecheck`：runtime、ai-runtime、web 均通过。
- `git diff --check`：提交前必须再次运行；文档或代码继续变更后以最后一次结果为准。

- deployment adapter unit tests（合法/非法路径、摘要、状态迁移、健康检查、rollback）；
- SQLite migration/repository 与 API 权限/幂等集成测试；
- Agent job lease、过期、重启 unknown、capability allow-list 和回执脱敏测试；
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
8. 在 Doca 写入前读取最新版本；保存后回读设计文本、流程图节点和边。已完成：原生流程图可见，包含源码 workspace、SDK 扫描/人工确认/构建/Agent preflight/systemd 计划、管理员批准和待实现的 executor/验证/回滚边界。

## PR 发布前检查

- [x] 代码只在功能分支，目标为 `main`，没有直接推送主干。
- [x] SDD 任务状态和实现一致；未实现 provider 明确列在限制中。
- [x] `docs/system-design.md` 与 Doca 在同一 PR 同步；PR 描述列出仓库章节、Doca 链接、写入/回读结果。
- [ ] 管理员审批、secret 脱敏、SSH 清理提示和错误码均有 UI/AI 展示。
- [x] runtime typecheck 和相关部署/扫描测试通过；执行器、健康/遥测和未知结果仍明确标为未实现。
- [ ] PR 保持待审核，未经用户明确授权不合并。
