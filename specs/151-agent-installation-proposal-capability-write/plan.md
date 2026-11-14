# 实施计划

1. 复用 ExecutionGrantRegistry，domain=agent_installation、native_id=machine_deployments.id；外部计划、稳定 grant 与 capability_idempotency 在一个 SQLite 事务中接受。
2. CapabilityDispatcher 注册 agents.maintain.propose + agents.read，目标解析到 machine_id 并复用现有 Host 授权；只调用 ManagedMachineStore.assistantPlan。
3. 授权校验器从 native_id 重新读取 machine_id，在 Apply 前复验当前账户角色、稳定 grant、双 Scope 和主机范围。
4. registerManagedMachines 接收共享 Registry，原管理员 Apply 在状态改变、enrollment 或 SSH 前 assert；无绑定的内部/历史计划不受影响。
5. 内部 propose_agent_install 统一 Dispatcher，隐藏自动 reason/idempotency 并返回原计划；移除旧工具重复注册。
6. 添加真实 Store/计划/权限/撤销、内部助手和官方 MCP 测试，更新系统设计、接入文档与覆盖矩阵，执行全量回归、类型检查和构建。
7. 创建面向 main 的 stacked PR，注明依赖 #192～#204，不合并。
