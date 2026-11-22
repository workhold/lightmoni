# 契约

## 受管派发校验错误处置（`prepare()`）

| 校验错误 | 处置 | 任务终态 |
| --- | --- | --- |
| `machine_execution_locked` | 跳过本轮派发，任务保留 `queued`，无事件写入 | 待派发（或到期 `queue_expired`） |
| `agent_upgrade_required` | `failQueuedSSH`，保留精确错误码（SDD129） | `failed` |
| 其余 `HTTPError` | `jobs.cancel('approval_invalid: <code>')` | `cancelled` |
| 非 `HTTPError` | 原样上抛 | 不变 |

- 每轮派发仍完整执行 `source()` 审批重验与 `idle()` 互斥检查；本契约不改变 `idle()` 的判定条件与错误码。
- 队列顺序仍为 `ORDER BY created_at,id`；被保留任务相对后续新建任务保持优先。
- 过期清扫语义不变：排队任务超过 `expires_at` 由 `sweep()` 以 `queue_expired` 终结。
