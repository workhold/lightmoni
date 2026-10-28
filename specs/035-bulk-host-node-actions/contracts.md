# 复用接口契约

- SSH 预检 `POST /machines/:id/ssh-check {credential_id}`，结果 ready、arch、id、expires_at 与 agent_installation 按现有契约。
- 安装准备 `POST /machines/:id/deployments/plan {check_id,credential_id,version,arch}`，架构来自预检；确认 `POST .../:plan/apply {confirm:true}`；取消 `POST .../:plan/cancel {}`；未知响应读取同一计划，不重新 apply。
- 卸载准备 `POST /machines/:id/uninstallations/plan {check_id,credential_id}`；确认/取消/读取均复用对应既有路由。unknown 必须显示核对入口。
- 节点移除 `POST /agents/:id/remove {confirm:true,reason?}`；删除主机 `DELETE /machines/:id`。不新增批量写入后端，不把服务器逐台确认当作全批次事务。
- 批量 UI 不提交私钥/密码，不接受命令、任意地址或安装路径，只提交服务器记录 ID、版本和已有审核数据。
