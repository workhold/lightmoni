# SDD 176 契约

## POST /api/v1/machines/:id/agent-updates/:updateId/reconcile（扩展）

请求体在既有 `credential_id` 之上新增可选字段：

- `resolution`: `"keep_current"`（唯一合法值；缺省走原只读核对流程）
- `reason`: 字符串，`resolution` 存在时必填，非空且 ≤500 字符

`resolution=keep_current` 行为：仅管理员；先拒绝仍在启动确认窗口内的记录，再以 fresh 只读 probe 依次验证：当前程序不是本次目标发行（命中即 409，提示改走只读核对提交流程）、受管安装健康、无生命周期/操作锁、Agent 身份一致、当前服务状态与审批计划原程序服务状态一致；全部满足则将 unknown 终结为 `failed`（receipt.manual_keep_current、error「管理员只读核对后确认维持原程序，本次维护未执行」、keep_current 事件），不执行恢复验证标记。前提不满足返回 409 `agent_update_keep_current_unverified` 或既有 probe 拒绝消息。响应同 `GET .../:updateId`。

## GET /api/v1/machines/:id/busy（新增，管理员）

`200 {machine_id, busy: boolean, holder?: string, since?: string}`；holder ∈ terminal / ssh-check / installation / deployment / agent-update；since 为 ISO 时间。主机不存在 404。

## POST /api/v1/machines/:id/busy/release（新增，管理员）

请求 `{confirm: true, reason: string(非空≤500)}`。释放该主机内层 busy 车道（仅内存），返回 `200 {machine_id, released: boolean, holder?, since?}`；无占用时 `released:false`（幂等）。释放写结构化审计日志（event=machine_busy_release，含 actor/holder/since/reason），不修改数据库围栏与远端主机；数据库围栏仍由任务自身收尾或既有核对/恢复协议处理。

## 消息契约（fail 409 文本，Web 映射按完整键匹配）

- idle 车道：`此主机有{holder中文}操作进行中（自 {ISO} 起），请等待其结束；若确认操作已异常中断，管理员可通过主机忙状态接口释放`
- probe 前提细分（固定前缀 + 原因与处置建议，四条）：
  - `Agent 不是空闲且健康的受管 systemd 安装：远端安装未通过受管校验，请检查安装状态后重试`
  - `Agent 不是空闲且健康的受管 systemd 安装：Agent 服务未在运行`
  - `Agent 不是空闲且健康的受管 systemd 安装：生命周期锁未释放，可能有维护进程仍在进行；确认无维护进程后清理 /run/lightmoni-agent-lifecycle.lock`
  - `Agent 不是空闲且健康的受管 systemd 安装：操作锁未释放，主机存在未收尾的维护或任务状态文件；若维护已中断，重启 lightmoni-agent 服务让 Agent 自检回收后再试`
- 漂移维度：`agent_update_recovery_unverified：{程序指纹|运行模式|权限代次|执行通道状态|原程序服务状态}与审批计划不一致，无法核实本次维护未执行`（保留既有错误码前缀，动态后缀不做 Web 键映射）
- taskBusy 明细：`主机存在待执行、运行中或结果未知的任务，请先处理（{kind} {id前8} {state}、…）`（最多 8 项；明细为空回退原文）
- keep_current 拒绝：`agent_update_keep_current_unverified：{原因}`（服务状态不一致等）

## 内部契约

- `maintenanceBlockers(deps, agent, machine): {kind,id,state}[]`：kind ∈ executor_bootstrap/task_run/agent_job/privileged_job；只读，不影响 `maintenanceWorkBusy` 语义。
- busy 车道值 `{holder: string, since: epoch_ms}`；`Map.has` 语义与原 `Set` 一致，能力投影 `host_busy` 判断不变。
