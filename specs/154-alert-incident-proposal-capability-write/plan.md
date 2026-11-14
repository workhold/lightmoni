# 实施计划

1. 将 Alerts.acknowledge 的只读组成员/规则检查与同步事务提交拆成 prepareAcknowledge/commitAcknowledge，原方法保持签名与行为。
2. AlertCapabilities 增加 incident.ack 的安全预览和 generation+规则/组 revision 绑定，审批时重新 prepare，提交调用原 commitAcknowledge。
3. AlertProposalService 接受 incident.ack 目标，保持原事务内提案/幂等/审计；MCP 返回受保护 review_url。
4. Dispatcher 对 incident.ack 动态复验 alerts.incidents.read，目标类型解析为 alert_incident；内部 propose_alert_change 复用同一路径。
5. 添加真实 Alerts/响应、权限、撤销、revision、敏感投影、内部助手和官方 MCP 隔离 E2E。
6. 更新系统设计、接入文档与覆盖矩阵，运行全量回归、类型检查和构建，创建面向 main 的 PR，不合并。
