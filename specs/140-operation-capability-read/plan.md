# 实施计划

## 1. 共享读取服务

- 将 operation-tools 的 resourceForModel、runMetadata、runForModel 和分页/大小限制迁到 OperationsReadService。
- 增加资源 get、Run 列表和 Schedule list/get；Run 列表只使用安全元数据。
- OperationsStore 与 Schedule 模块继续拥有真实状态；服务不重写状态。

## 2. 描述符与权限

- 注册 resources.list/get、runs.list/get、schedules.list/get。
- 全部 operations.read、admin、allHosts=true；资源/计划为 R0，Run 详情和 Schedule 输入为 R1。
- 列表使用有界 offset/limit，详情沿用 28 KiB 模型限制，最终仍受能力 64 KiB Envelope 限制。

## 3. 内部助手与装配

- Dispatcher 添加两个旧名称和四个新名称适配器。
- registerAssistant 过滤两个旧读取，保留内部 propose_operations_action。
- 应用保存 OperationSchedules 实例并与 OperationsStore 一起注入 Dispatcher。
- MCP 接入页增加 operations.read 中英文标签。

## 4. 验证与交付

- 添加资源/Run/Schedule、权限、敏感投影、内部助手和官方 MCP 客户端测试。
- 复跑运维执行/API/AI、核心、描述符和其他已迁移领域回归。
- 执行全仓类型检查、构建和 runtime 全量；main 既有失败单独对照。
- 更新系统设计、平台 MCP 和接入指南，推送 stacked 分支并创建面向 main 的 PR，注明依赖 #192/#193，不合并。
