# 契约

- 使用现有GET /privileged-execution/jobs/:id；404仅代表没有对应特权记录，不猜测结果或执行身份。ID、machine_id、capability三者必须匹配，失败时不挂载可写控件。
- 复用现有POST reconcile {confirm:true,reason}与cancel {confirm:true}，服务器仍要求human管理员。未知状态核对后保持unknown和原code，显示resolved_at与原因，不重放任务。
- 敏感输出仍须单独显式读取；列表和探测请求不读取输出。请求过期、响应身份变化、提交不确定时保持原组件的刷新要求。
- 旧普通作业、非管理员不获得新的作业控制入口；不放宽未知实例的停止/卸载边界。
