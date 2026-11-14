# 实施计划

1. InstrumentationService 增加来源元数据和同步 persist hook；异步扫描结束后，由 Dispatcher 在一个 SQLite 事务中保存加密计划、稳定 grant 和幂等记录。request hash 包含能力版本、排除 base_revision，目标快照独立保存。
2. ExecutionGrantRegistry 增加 instrumentation 域及必要绑定检查；原管理员 Apply 在 revision/文件写入前复验外部授权，无绑定外部计划 fail closed。
3. 注册 code.workspace.propose + code.workspace.detail.read，创建/回放返回 proposal、plan 摘要、applied 和受保护 review_url；内部来源保留完整计划。
4. 新增原生 GET /api/v1/instrumentation-plans/:id，复用 read 投影，管理员可审阅完整 Diff；既有 Apply 仅接受人类管理员会话。
5. 内部 propose_sdk_instrumentation 统一 Dispatcher，隐藏自动 reason/idempotency，返回原 InstrumentationPlan，移除重复旧工具。
6. 添加真实 Store/文件不变、权限、撤销/无绑定、并发幂等、接受回滚、内部助手和官方 MCP→人工 Apply→真实文件变更→MCP 回读的隔离 E2E。
7. 更新系统设计、接入文档与覆盖矩阵，运行全量回归、类型检查和构建，创建面向 main 的 PR，不合并。
