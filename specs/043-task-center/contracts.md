# 契约

现有 GET/POST/PUT/DELETE /api/v1/agent-tasks 继续作为统一任务定义 API，内部路径名称不决定产品概念。

Task 扩展：`origin: builtin|custom`、`template_id`、`target_all: boolean`、`host_ids: string[]`、`schedule: {mode: continuous|once|interval, interval_seconds?: number}`、`script?: {runtime: shell|node, code: string, timeout_seconds: number, max_output_bytes: number}`。内置任务 type 保持 host/probe/log，自定义脚本为 script；内置 config 保持 RemoteConfig。未指定新字段的已有定义保留原目标与行为，不在重启时恢复停用任务。

- GET /api/v1/task-templates：平台只读模板。
- GET/POST/PUT/DELETE /api/v1/host-labels[/:id]：主机标签目录，含 host_count/task_count。
- GET/PUT /api/v1/machines/:id/labels：主机标签，写入 `{label_ids: []}`，允许无 Agent。
- GET /api/v1/machines/:id/tasks：主机的有效任务和配置状态。
- PUT /api/v1/machines/:id/task-overrides/:taskId：单机 `{enabled?,config?}` 覆盖；DELETE 清除覆盖。
- POST /api/v1/agent-tasks/:id/dispatch：`{host_ids?:[],confirm:true,expected_task_revision,request_id?}`，派发脚本到当前任务目标中的选中主机，返回 `{runs:TaskRun[]}`。审阅版本为 Task.revision；写事务内复核，不符返回 409。可选 request_id 对同任务/主机派发幂等。
- GET /api/v1/task-runs：执行历史，可按 task_id/host_id/state 过滤，limit 默认 100、最大 200；返回摘要数组（stdout/stderr/script.code 为空且 details_omitted=true）。GET /api/v1/task-runs/:id 返回完整快照及输出，避免列表轮询放大响应。
- POST /api/v1/task-runs/:id/cancel：取消待执行任务或请求终止运行任务。
- POST /api/v1/task-runs/:id/retry：`{confirm:true,expected_task_revision}`，明确审阅当前定义后重试，生成新记录；旧记录保留 retry_of/superseded_by 链接，不重新执行旧代码快照。
- POST /api/v1/task-runs/:id/resolve：仅管理员，`{confirm:true,reason}`，reason 去除首尾空白后为 1–512 字节。仅适用于未被重试取代的 unknown；必须人工核对远端进程已结束。保持 state=unknown 与原始输出/错误，记录 resolved_at/resolved_by/resolution_reason；再次调用返回首次审计结果，不修改原因。已确认记录不再阻塞主机/Agent 生命周期或后续配置周期，也不能重试；任何晚到 Agent heartbeat/result 返回 409，不能覆盖人工审计或原始状态。
- POST /api/v1/agents/:id/task-runs/claim：control 凭据领取。
- POST /api/v1/agents/:id/task-runs/:runId/heartbeat：携带领取凭证，续租并读取取消状态。
- POST /api/v1/agents/:id/task-runs/:runId/result：携带领取凭证提交有限输出、退出码和最终状态。

任务运行器与任务中心模型的具体共享 TypeScript 类型由实现模块导出；不允许通过 Agent 请求自行选择主机或更改脚本快照。所有用户写操作 requireAdmin，Agent 路由验证独立 control audience。

## 主机配置合并优先级

匹配某台主机且启用的自定义 host 任务覆盖该主机的内置 host 基线；该优先级只作用于匹配主机，不改变其他主机的默认采集。多个自定义 host 任务之间仍校验采集间隔/上报表冲突，冲突时整个修改回滚。单机覆盖仅作用于已匹配任务。Agent 心跳不能为自身添加主机标签，初始标签通过管理员主机操作写入，防止 control 凭据自行选择脚本派发范围。

## 默认任务升级策略

全新数据库：指标采集和无地址服务拨测均 enabled=true、target_all=true；拨测显示 waiting_config。旧数据库：仅将 ID 为 legacy:default:host/probe、类型未改、目标仍仅为 default 标签且无显式 host_ids 的任务提升为 builtin+target_all；保留 name/config/enabled。旧拨测的停用状态保留，用户可显式开启或从模板创建，迁移不会推断停用意图。用户已更改目标/类型的任务保持原状，迁移标记保证不会在重启时再次覆盖。

主机任务状态 active 表示持续任务已启用且 Agent 近期在线，不代表已回传配置应用或采集成功；前端不得把它称为“已应用”。内置指标被匹配的自定义指标任务替代时状态为 overridden_by_custom。真正应用状态继续由 Agent 的 config_revision/心跳观测确认。

## 有限脚本执行协议

- Agent 心跳公布 task_capabilities=["task.script.v1"]；claim 请求携带 capabilities，旧 Agent 不会领取脚本。在线但不支持的主机状态为 upgrade_required。
- claim 返回 `{run: ClaimedTaskRun|null}`，仅领取响应包含一次性 lease_token。数据库仅保存其 SHA-256，用户查询不返回凭证。heartbeat/result 必须提供该 lease_token，且独立 control audience、Agent ID、当前主机绑定均一致。
- 租约 60 秒；running 租约丢失记 unknown，不重新入队。queued 最长等待 24 小时后取消。定时任务 10 秒至 30 天固定间隔，持久化 next_due，不追赶离线周期；同任务/主机存在 queued/running/未核对且未被显式重试取代的 unknown 时不叠加。resolved_at 只代表管理员已核对进程结束，不代表执行成功。
- 取消 queued 立即成为 cancelled；取消 running 只记录 cancel_requested，Agent heartbeat 读取后终止脚本并回传最终结果。未回传的运行中取消仍可能成为 unknown，不伪装已停止。
- 脚本最长 64 KiB，timeout_seconds 1–3600，max_output_bytes 1024–262144（stdout/stderr 总和）。Node.js 与 POSIX shell 使用文件和固定 argv 启动、独立工作目录、最小环境，不注入 control/data 凭据；输出对已知凭据脱敏。
- Agent 的独立 Node 监督进程观察父进程与自身超时，清理同进程组脚本；这是有限执行机制，不是操作系统沙箱，代码拥有 Agent 用户权限。Agent 本地持久化执行/结果标记，崩溃后只报告 unknown，丢失结果响应只重发原 receipt，不再次启动脚本。
