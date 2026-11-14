# 实施计划

1. 将 responseStatistics 算法原样抽为 AlertReadService.responseStatistics，原路由调用并 c.json。
2. 注册 alerts.statistics.read、外部统计工具和内部旧风格适配器；添加 MCP 标签。
3. 使用真实 assignments/responses 验证筛选、零成员、统计和权限；在现有 MCP 告警测试中调用统计。
4. 编写 Slice 2 覆盖矩阵，明确已迁移领域及后续安全/执行切片。
5. 复跑告警/domains/全领域回归、类型检查、构建和 runtime 全量，创建面向 main 的 PR，不合并。
