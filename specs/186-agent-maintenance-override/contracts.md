# SDD 186 契约

- `POST /api/v1/machines/:id/agent-updates/plan`：可选 `force_unknown: true, force_reason: string`；仅交互管理员可使用。`/start` 单击升级不接受强制参数。
- `POST /api/v1/machines/:id/uninstallations/plan`：相同可选字段，兼容 `standard` 与 `recovery` 模式。
- 计划 `plan.force_unknown` 为 `{reason,blockers:[{kind,id,state:"unknown"}]}`；缺省计划没有该字段。
- 强制计划的 `apply` 沿用原接口和 `{confirm:true}`，要求交互管理员会话。状态漂移返回 409，不派发远端命令。
- 普通客户端不传新字段时，响应及行为兼容旧版本。
