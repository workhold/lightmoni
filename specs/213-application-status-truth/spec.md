# SDD213：应用状态只由已验证的观测决定

**分支**：`codex/213-application-status-truth`
**日期**：2026-11-22
**状态**：已实施

## 背景

生产实例（moni.heyphp.com）的 `/applications` 页面持续出现应用状态误报（失败/结果未知/待核实），当前唯一恢复手段是对 agent 重新执行修复。排查确认根因不在探测链路本身，而是中心侧把**任务投递层的瞬时故障**直接当成**应用状态事实**写入，且部分错误状态没有自动恢复路径：

1. **租约超时 → unknown → 拒收真相并阻塞自愈**。Agent 每 15 秒以事件续租、租约 45 秒（`runtime/src/server/agent-jobs.ts` `LEASE_SECONDS`）；一次约 45–60 秒的抖动（网络、中心繁忙、Agent 事件循环被 docker stats 阻塞）即可使租约清扫把任务置为 `unknown` 并清空 `lease_id`。Agent 随后提交的**真实执行结果因 lease 失配被 409 拒收**——事实被丢弃。实例进入 `unknown` 后：具备 reconciliation 能力的 Agent（线上新版）不参与 tick 直派巡检（`runtime/src/ops/cluster-workloads.ts` tick 的能力过滤），而 ReconciliationRegistry 对 `unknown_execution_result` 一律返回 `blocked` 且不派发任何只读核对——只能人工「修复 agent」。旧版 Agent 反而能靠 tick 巡检自愈。
2. **apply 一次瞬时失败直接落 `failed`**。执行环境瞬时错误（docker 超时、守护进程不可用等）使 run 失败时，订阅器直接把实例 `state='failed'`、`healthy=0`，卡片显示红色「失败」，即使上一代容器仍在正常服务。
3. **HTTP 健康探针默认只认 200 且 `redirect:'manual'`**。任何重定向（HTTP→HTTPS 跳转、登录跳转）都判为不健康，此类应用永远无法达到 ready，长期显示待核实。

## 用户场景与验收

管理员打开 `/applications`：只要中心↔Agent↔主机链路通畅且应用实际正常，卡片状态应保持「运行中」；瞬时抖动最多把卡片短暂降级为「待核实」，并在链路恢复后**自动**回到真实状态，无需人工修复 Agent。只有链路真断或应用真坏（观测证实）才保持异常。

1. 给定实例 `state='unknown'` 且其 Agent 在线并具备 reconciliation 能力，当 tick/registry 运行时，中心自动派发只读 `workload.inspect`；巡检证实 `configuration_matches===true && healthy===true` 后实例回到 `running`、卡片回到「运行中」，不产生任何写操作。
2. 给定只读任务（`.inspect`/`.logs`）的租约超时被置 `unknown`，当 Agent 在 10 分钟窗口内携带原 lease 提交终态回执时，中心接受该回执并按其内容更新任务与实例状态；写任务的迟到回执仍被拒收，人工恢复流程不变。
3. 给定非 inspect 任务以执行基础设施类错误码失败（命令层映射产生的 `operation_command_timeout`、`operation_dependency_unavailable`（含 docker CLI 缺失）、`docker_permission_denied`、`docker_daemon_unavailable`），当订阅器处理该回执时，实例回落到最后一次已验证的观测状态（`observed_json`，从未验证过则保留原状态，不伪造 `running`）、`healthy=0`、`health_failures` 递增，卡片降级为「待核实」并由既有 repair 重试恢复；业务性失败码仍按现行为落 `failed`。
4. 给定 HTTP 健康探针未显式配置 `expected_statuses`，当探测收到 2xx 或 3xx 响应时判定健康；显式配置的应用判定完全不变；TCP 探针不变。

## 要求

- **FR-001**：registry `reconcile()` 对 `unknown` 实例 / agent 存在 unknown 阻塞任务时派发只读核对（复用 verify），带冷却窗口防止巡检风暴；**写操作 fence 语义完全不变**（unknown 写结果仍不得盲目重试，观测证实漂移仍走人工审核）。
- **FR-002**：能力分工覆盖两类 Agent——具备 reconciliation 能力的走 registry 自动核实；旧版 Agent 维持 tick 巡检自愈（现状已满足，不重复派发）。
- **FR-003**：租约清扫置 `unknown` 时保留原 `lease_id`；只读任务在窗口内接受原 lease 迟到终态回执并写审计事件；事件序号、`EVENT_ORDER`、`recoverUnknown`、写任务行为均不变。
- **FR-004**：订阅器对基础设施类错误码保留实例原状态；错误码清单与 `runtime/src/agent/operations.ts` 的映射保持一致。
- **FR-005**：探针默认判定放宽为 2xx+3xx，显式 `expected_statuses` 优先。
- **FR-006**：四条验收场景均有回归测试，且在未修复代码上失败。

## 架构影响

**适用**（控制路径语义变化）：变更 Agent 任务租约 unknown 处置（迟到只读回执）、实例状态机改写条件（基础设施失败不落 failed、unknown 自动只读核实）与健康探针默认语义，需同步 `docs/system-design.md` 对应章节。组件职责、凭据边界、存储结构、协议与部署拓扑不变。

## 非目标

- 不改变 unknown 写任务的人工恢复/审核闭环（specs/192、203、205、206 建立的安全边界）。
- 不改动前端 `resourceState` 推导规则与状态词汇表。
- 不改动受管（root 模式）privilege jobs 的租约与解决流程。
- 不递增版本号（本 PR 不打包容器镜像）。
