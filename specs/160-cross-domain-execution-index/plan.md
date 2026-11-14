# 实施计划

1. 新增 ExecutionIndex 安全投影类，复用现有 execution_index 表并支持 domain/native_id/host/state 查询。
2. Dispatcher 实现各领域原生视图与统一投影，list/get 按 Scope、Host、domain/state 过滤并刷新 native_state/review_url。
3. 注册 lightmoni_domain_executions_list/get 和内部适配器，保持现有 executions list/get 任务专用兼容。
4. 添加 Task/Deployment/Operation/Agent 首装/维护索引、权限、分页和官方 MCP 测试。
5. 更新系统设计、接入文档与覆盖矩阵，运行全量回归、类型检查和构建，创建面向 main 且注明依赖 #214 的 PR，不合并。
