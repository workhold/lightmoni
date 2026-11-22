# 设计

## 现状

`prepare()` 由执行器领取（`claim`）与 `prepareSSH` 触发，每次取最旧的排队受管 `agent_jobs`，经 `source()` 重验审批后调用 `enqueueManaged` 签名入队。`enqueueManaged` 以 `idle(machine, agent, job.id)` 做互斥判定：同一机器存在其他已排队/运行中的 `privileged_jobs`、阻断态 `agent_jobs` 或 `task_runs` 时抛出 `machine_execution_locked`。原实现的 catch 分支把该错误与授权失效一同处理，调用 `jobs.cancel`，使排队任务立即终态 `cancelled`。

## 方案

在 `prepare()` 的 catch 中，先识别 `machine_execution_locked` 并直接返回：该错误只说明本轮无法互斥进入执行通道，任务审批本身未失效。任务留在 `agent_jobs` 队列，下一轮执行器领取时按 `ORDER BY created_at,id` 优先派发（排队任务早于后续新建的观测任务）；每轮派发仍完整执行 `source()` 审批重验与 `idle()` 互斥检查，安全边界不变。

长期占用（如 `unknown` 未核对）导致的持续阻塞不引入新语义：任务保留至 `expires_at`，由既有 `sweep()` 以 `queue_expired` 终结，人工核对路径不变。

## 备选方案

- 区分 `idle()` 各子条件的错误码并仅对「运行中占用」豁免：需新增错误码并同步界面文案，收益有限，本次不做。
- 前端对 `cancelled` 自动重试：掩盖根因且其他交互式受管操作不受益，不采用。

## 风险

- 队列中任务在持续忙碌时等待变长：受既有 `expires_at` 与清扫约束；观测任务短且有间隔，实测在空闲窗口即可派发。
- 依赖 `machine_execution_locked` 语义稳定：该错误码为既有对外契约，`idle()` 判定未改动。
