# 实施计划

1. 扩展任务 ProposalSource 的服务 subject/Owner 与能力输入证据，原生 load 允许服务本人和 Owner 读取，Apply 只允许人类 Owner；审批写回、审计和运行 actor 保持正确身份。
2. 将任务持续授权拆为不扣预算的 authorizeContinuation 与提交时 authorizeInvocation，McpAccess 仅额外允许 tasks.plan 的三项既有任务动作。
3. Dispatcher 在审批与 beforeStart 复验服务策略；run authorization 增加 proposal_id 并在自动重试复制，个人 PAT 保持原路径。
4. 添加服务提案正常闭环、自批/他批拒绝、审批策略漂移、领取撤销、自动重试、预算与兼容测试。
5. 更新系统设计、平台 MCP、接入文档与 SDD 162 当前边界说明，运行定向/全量测试、类型检查、构建和文档检查，创建注明 #218 依赖的 stacked PR，不合并。
