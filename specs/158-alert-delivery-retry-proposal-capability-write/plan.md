# 实施计划

1. 将 Alert API 重试排队提取为 Alerts.prepareDeliveryRetry/commitDeliveryRetry，保留状态白名单、unknown 明确确认和时间/计数字段。
2. AlertCapabilities 增加 delivery.retry 的安全预览和原 outbox 内容摘要绑定，审批后调用原 commitDeliveryRetry/updateDelivery。
3. AlertProposalService 接受 confirm_possible_duplicate，Dispatcher 对 delivery.retry 动态复验 notifications.read，内部工具复用同一路径。
4. 添加状态白名单、unknown 确认、幂等、权限、敏感投影、内部助手和官方 MCP 真实 queued 隔离 E2E。
5. 更新系统设计、接入文档与覆盖矩阵，运行全量回归、类型检查和构建，创建面向 main 且注明依赖 #212 的 PR，不合并。
