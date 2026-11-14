# 实施计划

1. 将 Alert API 的转交与分页重置提取为 Alerts.prepareTransfer/commitTransfer/resetPaging，保留原错误状态和通知取消语义。
2. AlertCapabilities 增加 incident.transfer 的安全预览、目标成员校验及 generation+规则/组 revision 绑定，审批后调用原 commitTransfer。
3. AlertProposalService 接受 user_id，Dispatcher 对 incident.* 动态复验 incidents.read 和稳定 grant，内部工具复用同一路径。
4. 添加有效/无效成员、幂等、权限、敏感投影、内部助手和官方 MCP ack→transfer 隔离 E2E。
5. 更新系统设计、接入文档与覆盖矩阵，运行全量回归、类型检查和构建，创建面向 main 且注明依赖 #209 的 PR，不合并。
