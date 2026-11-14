# 实施计划

1. 将 Alert API 主动升级提取为 Alerts.prepareEscalate/commitEscalate，复用 resetPaging，保留权限、stage 和审计语义。
2. AlertCapabilities 增加 incident.escalate 的安全预览和 generation+规则/组 revision 绑定，审批后调用原 commitEscalate。
3. AlertProposalService 接受操作，Dispatcher 对 incident.* 动态复验 incidents.read，内部工具复用同一路径。
4. 添加 stage、幂等、权限、敏感投影、内部助手和官方 MCP ack→escalate 隔离 E2E。
5. 更新系统设计、接入文档与覆盖矩阵，运行全量回归、类型检查和构建，创建面向 main 且注明依赖 #210 的 PR，不合并。
