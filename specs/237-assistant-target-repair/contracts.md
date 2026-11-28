# 工具与确认契约

- `propose_service_target_repair` 只接受管理员的 `service_id`、`target_id`、`preflight_id` 和至少一个明确的 `unit` 或 `release_directory`。原预检必须新鲜、已完成、未就绪并能解释对应字段。重复提交相同提案返回原记录。
- `get_service_target_repair` 与 `GET /api/v1/service-target-repairs/:id` 读取当前用户的提案和关联预检。此功能不向外部 MCP 发布。
- `POST /api/v1/service-target-repairs/:id/apply` 要求管理员提交 `confirm: true` 与已审核的 `expected_revision`。原预检过期或被替代、目标配置或主机身份变化、目标已有在途部署时，拒绝保存。重复确认返回同一回执。
- 修改仅写入原生服务目标中已审核的字段。新预检使用原生签名作业。入队失败时配置保存一起回滚。部署仍需原生检查和审批。
