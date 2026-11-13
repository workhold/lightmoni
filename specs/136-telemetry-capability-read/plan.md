# 实施计划

## 1. 领域服务

- 新建 TelemetryService 承接目录 list/describe 和统一 Query 调用。
- 从 assistant/tools.ts 移除重复实现，旧监控工具转为服务委托。
- 保留 1000 行采样并增加 60 KiB 数据采样预算，为 64 KiB 完整 Envelope 留出空间；无法安全缩小的元数据继续 result_too_large。

## 2. 能力与权限

- 注册 catalog/describe/query 描述符，operationKind=telemetry_query 用于真实查询，query 使用更严格的 30 次/分钟和 2 并发。
- 增加 telemetry.query Scope 和描述符角色策略。管理员获得全部既有权限；成员会话仅获得遥测只读 Scope，外部 scopesForUser 仍为管理员专用。
- 所有遥测描述符 allHosts=true，直接调用也拒绝有限主机授权。
- 内部助手过滤三个旧实现，使用 Dispatcher 适配器，避免同名重复注册。

## 3. MCP 与接入页

- 保持现有 catalog 名称和输出，新增 describe/query outputSchema。
- 为 telemetry.query 添加中英文标签，OAuth/PAT 自动沿用服务端 Scope 列表。
- 使用官方 MCP SDK 验证真实发现、目录、表结构、查询和权限拒绝。

## 4. 验证与交付

- 新增服务/权限/采样/内部适配器和 MCP 客户端测试。
- 复跑核心、描述符、MCP、授权、助手与模式基线回归。
- 执行全仓类型检查、构建和 runtime 全量；main 既有失败单独对照。
- 更新系统设计、平台 MCP、接入指南和工具矩阵，推送 stacked 分支并创建面向 main 的 PR，注明依赖 #186/#187，不合并。
