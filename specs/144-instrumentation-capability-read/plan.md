# 实施计划

## 1. InstrumentationService 读取

- 保留 scan；新增 read(plan_id) 返回 `{plan,applied}`，不返回 before 快照。
- 扫描和读取均复用既有记录、revision、加密存储和安全工作区。

## 2. 描述符与权限

- scan 使用 code.workspace.read，返回真实 InstrumentationScan。
- get 使用 code.workspace.detail.read，返回完整插桩提案和安全 applied 结果。
- 全部 admin、allHosts=true、R1；只读，不授予生成或 Apply。

## 3. 共享装配与内部助手

- 应用在配置中心工作区时创建共享 InstrumentationService，并用原加密 Store。
- registerAssistant 支持注入该实例，Dispatcher 与 Assistant 不分别创建不同存储实例。
- Dispatcher 添加 scan_sdk_instrumentation/get_sdk_instrumentation；过滤旧扫描，保留内部 propose。
- MCP 接入页增加两个 Scope 的中英文标签。

## 4. 验证与交付

- 使用临时真实工作区添加扫描、提案读取、权限、内部助手和 MCP 客户端测试。
- 复跑 instrumentation/code-task、核心、描述符和其他领域回归。
- 执行全仓类型检查、构建和 runtime 全量；main 既有失败单独对照。
- 更新系统设计、平台 MCP 和接入指南，推送 stacked 分支并创建面向 main 的 PR，注明依赖 #192～#197，不合并。
