# 实施计划

1. 扩展 Principal/Authority 的可选主体类型和能力策略钩子，由 CapabilityAccess 委托外部授权；缺省主体仍为用户，缺少服务策略适配器时失败关闭。
2. 在 McpAccess 增加独立服务账户、服务 grant/token 和预算存储，复用现有 Scope、Host、grant 复验、token hash 与撤销机制；服务 ID 不写入 users。
3. 新增管理员 Web 管理路由，按当前 Capability Registry 校验固定只读规则并派生最小 Scope；服务发现与调用使用同一规则，版本或策略不符即拒绝。
4. Dispatcher 在清单过滤时应用服务能力可见性，在 JSON Schema 校验后、目标访问和领域执行前校验固定输入并原子扣减预算；审计记录主体类型。
5. 添加服务身份、发现/HTTP/MCP 调用、输入/Host/版本边界、预算并发、撤销/过期/Owner 变化、秘密与兼容回归测试。
6. 更新 docs/system-design.md、docs/platform-mcp.md、docs/mcp.md 与能力覆盖矩阵，运行定向和全量测试、类型检查、构建及文档检查，提交独立 PR；未获授权不合并。
