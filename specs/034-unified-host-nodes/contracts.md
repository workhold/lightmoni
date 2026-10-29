# 接口契约

- `GET /api/v1/agents` 保持现有数组，新增 `lifecycle_state`（`active` / `removed`）、`removed_at`、`removal_reason`，默认只返回未移除节点；管理员 `include_removed=true` 可查询历史。已有节点字段不破坏。
- `POST /api/v1/agents/:id/remove`：管理员，JSON `{confirm:true,reason?:string}`；成功 `{agent_id,lifecycle_state:'removed',removed_at,credentials_revoked:true,remote_uninstalled:false}`。未确认 400，无权限 403，不存在 404，未结束任务/卸载或共享 Key 身份 409。重试幂等，不重新允许旧凭据。
- `POST /api/v1/machines/:id/agent-link`：管理员，JSON `{agent_id,credential_id}`；服务器使用已确认 SSH 指纹与有效私钥执行固定只读身份核验，成功返回主机概要。409 表示身份、绑定或操作冲突；不接受任意命令、IP 归并或前端自证。
- 卸载、主机删除、任务、任务标签 API 继续复用；成员不可借统一页面获得主机/SSH 管理权限。
- 接入状态明确区分“未安装/未绑定 Agent”、“Agent 在线/离线”、“已卸载”、“节点已移除”；移除不宣称停止远端程序。
