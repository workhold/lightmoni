# 契约

- `plan.effects.identities` 必须包含同机全部有效 enrollment，包括历史 agent_id；清单在审批前逐字复验。
- 仅 `agent_enrollments` 允许历史 agent_id 进入该快照；有效 executor 或其他主机工作仍不能混入。
- Apply 仅取消同机、计划时有效的 enrollment。计划后新增或变化必须失败，而不是顺带清理新身份。
- 成功只表示中心旧状态已修正，不表示远端重新安装或 Agent 已在线。
