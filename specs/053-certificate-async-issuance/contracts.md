# 契约

- `POST /api/v1/ops/resources` 创建 certificate：201 `{resource,run}`；成功仅表示保存并安排首轮申请，run 为后台执行，不等待 CA/DNS。新建即表示管理员授权本证书首轮签发或导入，auto_renew 单独控制后续续期。
- `POST /api/v1/ops/resources/:id/actions`，既有 `{revision,confirmed:true,action:issue|renew,input:{}}`：202 `{run}`，立即返回当前执行；同资源互斥。其他动作和内部领域 perform 等待契约保留。
- `GET /api/v1/ops/runs/:id`：既有回执，result 可包含 phase、code、message、error_type、http_status、request_id；只有已脱敏公开诊断。
- `GET /api/v1/ops/runs/:id/events?after=N`：管理员查询 `{run,events,next_after}`；events 按 sequence 升序，包含 phase、state、domain/attempt 等允许字段与时间，无请求正文/响应正文/凭据/挑战值。旧执行返回空事件，前端显示历史原因缺失提示。
- 资源状态：排队/申请中 → issued / failed / unknown；last_run_id 指向最近申请。步骤失败与清理失败独立，证书材料继续加密、公开状态只含元数据。
- 初始申请意图持久保存且至多创建一个首轮执行；进程重启将已有中心 running 标记 unknown，不能重放未知结果。系统日志 outbox 复用原有可靠投递与管理员查询边界。
