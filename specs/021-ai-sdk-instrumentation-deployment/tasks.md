# SDD 021：任务清单

> 状态以代码、测试和回读证据为准。本次提交完成的是可审阅计划与 Agent job/executor MVP 切片，并增加只读 systemd preflight；受控构建、制品分发、真实业务部署和遥测闭环仍未完成。
>
> `T003`/`T008` 的“已完成”表示独立的类型、registry 和 systemd 纯逻辑适配器已实现并测试；部署后的中心遥测验证、自动补偿和最终回滚状态仍待后续切片。T002/T010 已接入中心状态迁移、管理员审批、脱敏事件查询、Agent 回执推进和回滚提案；T012-T014 已接入有序 job 事件、只读 systemd preflight、能力执行器、取消/租约 unknown 处理和重启恢复，但不代表真实业务部署链路已经完成。

## A. 规格与领域模型

| ID | 任务 | 依赖 | 状态 | 验收证据 |
| --- | --- | --- | --- | --- |
| T001 | 固化 `service`、`service_target`、`release`、`deployment`、`deployment_event`、`instrumentation_plan` 和 `agent_job` 的字段、状态和关联 | — | 部分（services/targets/releases/deployments） | `runtime/src/server/service-deployments.ts`、API 测试 |
| T002 | 增加 deployment 状态机和合法迁移校验，区分 Agent 安装与业务部署 | T001 | 部分完成（中心迁移表、审批边界和有序 Agent 回执推进已实现；真实探测与补偿仍待接入） | `runtime/src/server/service-deployments.ts`、`runtime/test/service-deployments.test.ts` |
| T003 | 定义 provider registry、健康检查和固定错误码；unsupported provider 必须安全拒绝 | T001 | 已完成（MVP 类型/registry） | `runtime/test/deployment-adapter.test.ts` |

## B. SDK 源码扫描与受控应用

| ID | 任务 | 依赖 | 状态 | 验收证据 |
| --- | --- | --- | --- | --- |
| T004 | 实现 workspace scanner：语言、lockfile、框架入口、SDK 包/版本、服务标识和已有打点识别 | T001 | 部分（只读启发式 scanner） | `runtime/src/assistant/instrumentation.ts`、scanner fixture |
| T005 | 实现结构化插桩 plan/diff，无法安全定位时只给手动步骤 | T004 | 部分（只读提案；明确的 TypeScript/JavaScript 请求边界自动生成 diff，其余返回手动步骤） | `runtime/src/assistant/instrumentation.ts`、`runtime/test/instrumentation.test.ts`；未修改源文件的提案测试 |
| T006 | 在管理员确认 API 应用 diff，校验 base revision、路径限制、符号链接和大小限制 | T005 | 已完成（安全 apply；构建仍待实现） | `runtime/src/assistant/instrumentation.ts`、插桩 apply 测试 |
| T007 | 实现隔离构建 worker 和 release digest 元数据，脱敏日志并限制资源 | T006 | 待实现 | 可重复 digest、构建失败、secret 脱敏测试 |

## C. 业务部署与适配器

| ID | 任务 | 依赖 | 状态 | 验收证据 |
| --- | --- | --- | --- | --- |
| T008 | 完成 systemd `probe/plan/apply/verify/rollback` 纯逻辑实现和注册 | T001,T003 | 已完成（纯计划层） | `runtime/test/deployment-adapter.test.ts` 及边界覆盖 |
| T009 | 将 plan 序列化到 SQLite，保存制品、目标快照、previous 和 operation id | T001,T008 | 部分（计划/制品元数据） | `runtime/src/server/service-deployments.ts` |
| T010 | 实现业务 deployment plan、approve、status、events 和 rollback API | T002,T009 | 部分完成（plan/approve/status/events、Agent 进度/最终回执映射和 rollback_pending；真实 Agent preflight 已可独立检查并绑定快照，制品分发/中心 telemetry verify/rolled_back 仍待接入） | `runtime/test/service-deployments.test.ts` |
| T011 | 为 Docker Compose/Kubernetes 添加明确的 unsupported provider 响应和扩展注册点 | T003 | 待实现 | 不执行 shell 的负向测试 |

## D. Agent 受限执行

| ID | 任务 | 依赖 | 状态 | 验收证据 |
| --- | --- | --- | --- | --- |
| T012 | 实现 Agent job poll/lease/ack/result、过期和取消协议 | T009,T010 | 已完成（有序单调事件、幂等重放、健康回执前置条件、中心定时过期清理；签名 job 待后续） | `runtime/src/server/agent-jobs.ts`、`runtime/test/agent-jobs.test.ts` |
| T013 | 实现 capability allow-list executor：制品暂存、受控 systemd、健康检查 | T008,T012 | 部分完成（Linux 使用目录 FD 与 `O_NOFOLLOW` 执行文件写操作；非 Linux 拒绝暂存/激活；安全预检检查只读且隔离；业务制品传输待接入） | `runtime/src/agent/executor.ts`、digest/path/unit/preflight/FIFO 负向测试；Linux CI 仍需验证 |
| T014 | 实现 Agent 执行事件、脱敏摘要、重启后的 unknown 状态恢复 | T012,T013 | 已完成（回执/本地重启恢复；中心已用 Agent 回执推进部署状态） | `runtime/src/agent/jobs.ts`、`runtime/src/server/service-deployments.ts`、`runtime/test/agent-job-runner.test.ts` |
| T015 | 接入真实健康与遥测验证；区分部署成功、遥测未验证和失败 | T010,T014 | 部分完成（只读 Agent systemd preflight 已接入；Agent 计划内 health_check 通过后可标记业务健康成功；中心侧有界证据判定已实现；部署后的真实 health job 与 ClickHouse 查询待接入） | `runtime/src/deployment/verification.ts`、`runtime/test/deployment-verification.test.ts`、`runtime/test/service-deployments.test.ts` |

## E. AI 助手与工作台

| ID | 任务 | 依赖 | 状态 | 验收证据 |
| --- | --- | --- | --- | --- |
| T016 | 暴露扫描、插桩提案、构建/部署提案、状态和回执工具 | T004,T010,T015 | 部分（扫描、插桩提案、服务计划、状态和事件工具；apply 走管理员 HTTP 确认） | `runtime/src/assistant/tools.ts`、assistant tool tests、typecheck |
| T017 | 为源码 diff、部署计划、审批和执行时间线增加 Web 页面 | T006,T010,T015 | 部分（服务目标支持新增/编辑 systemd unit 与 release directory、查看 Agent 预检诊断及有效期；部署计划缺少 typed actions 时隐藏审批入口；增加未审批/未领取部署取消；源码 diff 页面待补） | `web/src/app/ServiceDeploymentsPage.tsx`、web typecheck/build |
| T018 | 在 AI 输出和 UI 中显示审批边界、风险、健康/遥测验证和 SSH 凭据清理提示 | T016,T017 | 部分（部署页面显示审批边界、Agent 要求、计划不可执行原因、取消限制、unknown 人工复核和遥测提示；AI/SSH 清理提示待补） | `web/src/app/ServiceDeploymentsPage.tsx`；双语状态与文案 |

## F. 安全、可观测性与文档

| ID | 任务 | 依赖 | 状态 | 验收证据 |
| --- | --- | --- | --- | --- |
| T019 | 为插桩、构建、Agent job、部署、验证、回滚写审计事件和关联 ID | T009,T012 | 待实现 | 审计查询和关联性测试 |
| T020 | 完成权限、secret 脱敏、签名 audience/TTL、幂等和资源上限审计 | T006,T013,T016 | 待实现 | 安全负向测试、`rg` secret 检查 |
| T021 | 更新 `docs/system-design.md` 的 HLD/LLD、数据流、部署拓扑和 API 索引 | T001,T010,T013 | 已完成（本次切片章节） | `docs/system-design.md` diff |
| T022 | 使用最新 Doca seq/epoch 更新对应富文本/原生图块并回读节点与连线 | T021 | 基线已完成；本轮部署取消控制路径增量待同步 | Doca 原生流程图保存后可见，节点/连线回读确认；本轮访问返回“资源不存在或无权访问” |
| T023 | 运行 runtime/web 检查，记录验证矩阵并创建待评审 PR；禁止直接合并 | 全部 | 已完成 | `validation.md`、PR #25（保持开启，未合并） |
| T024 | 把 Agent job 进度、取消、健康验证、成功/失败和未知结果安全映射到业务 deployment 状态 | T010,T012,T014 | 已实现（严格事件序号/阶段单调；无健康成功证据或执行中取消时保留 unknown；仅未领取/过期 job 可安全取消） | `runtime/src/server/agent-jobs.ts`、`runtime/src/server/service-deployments.ts`、对应服务部署与 Agent job 测试 |
| T025 | 为管理员提供安全取消部署计划入口，并避免向不可执行的通用计划显示审批操作 | T010,T012,T017 | 已实现（未审批计划可取消；已审批计划仅能取消 queued job；Agent 已领取时拒绝并保留主机状态检查边界） | `runtime/src/server/service-deployments.ts`、`runtime/src/server/agent-jobs.ts`、`web/src/app/ServiceDeploymentsPage.tsx`、对应 API/job 测试 |
| T026 | 通过 Agent job 执行只读 systemd preflight，并将有限快照按目标持久化及绑定到后续部署计划 | T010,T012,T013 | 部分完成（Linux 支持安全目录检查；不支持平台明确不就绪；拒绝符号链接、masked/过渡态和跨 job 快照重放；FIFO 不会阻塞；10 分钟快照；不生成部署动作；Linux 主机验证待 CI） | `runtime/src/agent/executor.ts`、`runtime/src/server/service-deployments.ts`、`runtime/test/agent-executor.test.ts`、`runtime/test/agent-jobs.test.ts`、`runtime/test/service-deployments.test.ts` |

## 推荐执行顺序

```text
T001 → T002/T003 → T004 → T005/T006 → T007
                 ↘ T008 → T009 → T010 → T012/T013 → T014/T015
T010/T015 → T016/T017/T018
T019/T020 → T021 → T022 → T023
T024 → T021 → T022 → T023
T025 → T021 → T022 → T023
```

任何任务若改变组件边界、协议、凭据、存储或部署拓扑，都必须先更新本 SDD 和 `docs/system-design.md`，并在同一 PR 完成 Doca 同步；不能把文档同步留给后续 PR。
