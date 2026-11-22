# 应用状态误报治理：让状态只由「已验证的观测」决定

## Context

生产（moni.heyphp.com）/applications 页面仍有应用状态误报（失败/结果未知/待核实），目前唯一恢复手段是人工"重新修复 agent"。排查确认根因不在探测链路，而是中心侧把**任务投递层的瞬时故障**直接当成**应用状态事实**写入，且部分错误状态没有自动恢复路径（新版 agent 反而比旧版更容易卡死）。目标原则：

> 实例状态只能被已验证的观测改写；投递层瞬时故障最多降级为「待核实」，链路恢复后自动回到真实状态；只有链路真断或应用真坏才保持异常。

确认的四个误报路径（链路正常、应用正常仍会发生）：

1. **租约超时 → unknown → 拒收真相 + 阻塞自愈**：agent 每 15s 续租、租约 45s（`runtime/src/server/agent-jobs.ts:80-81`）；~45-60s 抖动即把任务扫成 unknown 并清空 lease_id（`agent-jobs.ts:288-306`），agent 随后提交的**真实结果被 409 拒收**（`agent-jobs.ts:538`）。实例变 unknown 后：有 reconciliation 能力的 agent（线上新版）tick 巡检被跳过（`runtime/src/ops/cluster-workloads.ts:3223`），registry 对 unknown 一律 blocked（`cluster-workloads.ts:3288`、`3319-3320`），**无任何自动 inspect**，只能人工修复；旧版 agent 反而能靠 tick 自愈。
2. **apply 瞬时失败直接 failed**：docker 超时/守护进程抖动一次 → `state='failed'` 红色失败（`cluster-workloads.ts:2592`），即使旧容器仍在正常服务。（用户已选：降级为待核实）
3. **健康探针默认只认 200、重定向不健康**（`runtime/src/operations/platform.ts:544-561`，`redirect:'manual'`）：HTTP→HTTPS 跳转类应用永远不健康。（用户已选：放宽为 2xx+3xx）

## 改动内容

### 1. unknown 自动核实（核心，替代人工"修复 agent"）
- `cluster-workloads.ts` registry `reconcile()`（3283-3336）：实例 `state==='unknown'` 或 agent 存在 unknown 阻塞任务（3319 的 fence）时，不再直接返回 blocked，改为在冷却窗口内派发**只读** `workload.inspect`（复用既有 `verify()`，3306-3317 的 proof 消费链路不变）；**写操作 fence 语义完全不变**。
- `cluster-workloads.ts` tick（3221-3231）：有 reconciliation 能力的 agent 的 unknown 实例不再被排除，同样派发只读巡检。
- inspect 证实 in_sync 后，现有逻辑即恢复卡片为运行中（dispatch 覆盖 `current_run_id` → `unresolved_run_id` 消失、registry 返回 in_sync）。观测证实确实漂移时仍走人工审核——安全边界（unknown 写结果不得盲目重试）保持不变。

### 2. 接受迟到的只读结果
- `agent-jobs.ts` 租约清扫（288-306）：置 unknown 时**保留原 lease_id**；对 `.inspect`/`.logs` 只读任务，窗口内（10 分钟）携带原 lease 的终态回执可把任务从 unknown 转为 succeeded/failed，并写审计事件。写任务维持现行为（拒收 + 人工恢复流程），`recoverUnknown`、事件序号、EVENT_ORDER 等状态机语义不改。

### 3. 执行层瞬时失败不打 failed（用户已确认）
- `cluster-workloads.ts` subscriber（2591-2594）：非 inspect 任务失败且错误码属于执行基础设施类（复用 `runtime/src/agent/operations.ts:24-28` 的映射清单：`operation_command_timeout`、`docker_daemon_unavailable`、`docker_permission_denied`、`docker_cli_missing`）时，保留原 state、`healthy=0`、`health_failures` 照加 → 卡片降级为「待核实」（availability grace），由既有 registry repair 重试恢复。业务性失败（镜像拉取失败等）及有观测证据 `running===false` 的仍按现行为。

### 4. 健康探针默认值放宽（用户已确认）
- `runtime/src/operations/platform.ts:544-561`：HTTP 探针默认成功判定从「恰好 200」放宽为「2xx 或 3xx」；显式配置 `expected_statuses` 的应用不受影响；TCP 探针不变。

## SDD 与文档（按 AGENTS.md 流程）

- 新增 `specs/213-application-status-truth/`（spec.md / tasks.md / validation.md，编号顺延，模板参照 specs/205）；含背景、验收场景（上述四路径各一条，注明"未修复代码上必须失败"）、架构影响判断。
- 更新 `docs/system-design.md`：agent 任务租约与 unknown 处置、实例状态机改写条件、健康探针默认语义所属章节——本次属于控制路径语义变化，需同步设计文档。
- 功能分支 `codex/213-application-status-truth` → 推 GitHub origin → 面向 main 的 PR；PR 描述写明最终行为、兼容影响、验证结果。本 PR 不打包镜像，无需 bump 版本。

## 测试与验证

- `runtime/test/` 新增回归测试（node --import tsx --test，参照 `agent-jobs.test.ts`、`agent-job-fence.test.ts`、`reconciliation.test.ts` 既有模式）：
  1. 租约超时置 unknown 后：只读任务的迟到回执（原 lease）被接受并恢复实例状态；写任务的迟到回执仍被拒。
  2. 实例 unknown + agent 具备 reconciliation 能力：tick/registry 自动派发只读 inspect，证实 in_sync 后卡片回「运行中」（未修复代码上卡在 blocked）。
  3. apply 携带基础设施错误码失败 → 实例不落 `failed`（降级待核实并自愈）；携带业务错误码 → 仍 `failed`。
  4. 探针默认值：302/204 判健康、404/500 判不健康、显式 expected_statuses 优先。
- 全量 `npm --prefix runtime test`、`npm run typecheck`。
- 手动验证（可选）：本地 compose 起中心+agent，部署应用后制造 60s 网络隔离再恢复，观察卡片自动从「结果未知」回「运行中」，无需人工修复。