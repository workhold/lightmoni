# 实施计划

1. 复用 ExecutionGrantRegistry，domain=operation、native_id=ops_runs.id；创建时与幂等同事务绑定。
2. OperationsStore.approve 在 revision/Job 创建前复验；中心 privileged SSH 通过 Agent Job operation_id 再次复验，未开始时不获取主机租约。
3. 注册 operations.plan，使用原 Store.plan 和 OperationsReadService.metadata；proposal status 只表示审批接受，native_status 保留真实 Run。
4. 内部 propose_operations_action 使用 Dispatcher，Schema 隐藏内部自动 reason/idempotency；返回原 `{run}` 元数据。
5. 添加真实 Store/审批/派发、权限、幂等、内部助手和官方 MCP 测试，执行全量回归、类型检查和构建。
6. 更新系统设计、平台 MCP 和接入文档，创建面向 main 的 stacked PR，不合并。
