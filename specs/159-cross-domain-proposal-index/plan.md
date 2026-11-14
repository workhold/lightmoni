# 实施计划

1. 新增 ProposalIndex 表与 link/update 方法，字段只含安全投影；冲突时拒绝不同所有者/能力覆盖同一 domain/native_id。
2. 在 TaskProposalService、AlertProposalService 以及部署/运维/Agent 首装的 Dispatcher 事务中写入索引，保持原提案与幂等原子性。
3. Dispatcher 实现领域原生视图与统一投影，list/get 按 owner、domain/state、Scope、Host 过滤并刷新 native_status/review_url。
4. 注册 proposals.read 和只读描述符/内部适配器，保持原 lightmoni_proposals_get 任务专用兼容。
5. 添加各领域索引写入、审批后刷新、owner/Host/Scope/分页测试及官方 MCP 闭环。
6. 更新系统设计、平台 MCP、接入文档与覆盖矩阵，运行全量回归、类型检查和构建，创建面向 main 且注明依赖 #213 的 PR，不合并。
