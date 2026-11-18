# SDD 184 契约

- `POST /api/v1/machines/:id/agent-updates/start` 请求与响应结构不变。执行前可等待当前工作自然结束；等待超时返回 409，未发起远端维护。
- 主机 `capabilities.update_agent.available` 对有静态升级前提、当前仅瞬态忙的主机为 `true`；未决更新、缺少 Agent/可复用 SSH 凭据、安装卸载等仍为 `false`。
- `machine_maintenance_preparations` 继续使用原 machine/agent/token/到期字段；预约检查、作业入队与领取围栏继续沿用 `hasPendingAgentUpdate`。
- 中心 SSH 派发器在维护预约或更新记录存在时不启动未领取作业，不把它们标记为失败；围栏释放后继续原队列派发。等待不取消、释放、改写或标记成功任何现存 Agent 作业和平台运行记录。
