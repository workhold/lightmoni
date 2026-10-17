# Implementation plan

## Technical context

Node 24 LTS + TypeScript，Node 原生 HTTP 路由及 SQLite，ClickHouse HTTP，保持现有 React 与 Mastra worker。新项目 `runtime/` 按 shared/server/domains/assistant/agent 分层。旧 Go 作为迁移差分基线，全部等价后移除服务运行入口；Go SDK 独立保留。

## Constitution check

宿主权威由 Go 改为平台宿主，与用户明确迁移要求一致，修订语言绑定但保持认证、秘密、工具、SQL、预算和数据保护原则。实现前已有规格、质量检查及契约；生产数据不用于破坏性测试。

## Design and ownership

- 根 agent：shared 基础（HTTP、SQLite、加密、OTLP、ClickHouse）、server（认证/查询/摄取/目录/节点任务/设置/入口）、包依赖、部署和整体验收。
- domain agent：`runtime/src/domains/` 中日志、大盘、告警完整迁移及测试。
- assistant agent：`runtime/src/assistant/` 中模型设置/发现/测试、会话/SSE/工具与账本迁移及测试，复用 ai-runtime。
- node agent：`runtime/src/agent/` CLI、持久队列、采集/日志/拨测/控制与测试。
- 公共接口冻结于 contracts/runtime.md，只有 root 修改 package.json/tsconfig 和 shared 模块。

## Sequence

冻结契约与旧行为样例 → 基础设施及差分 fixture → 并行完整模块实现 → 权限/精度/持久化/调度集成 → 生产构建、部署切换及旧数据副本验证 → 移除替代实现并提交 PR。阶段完成逐项标记，未通过的能力保留为待办。
