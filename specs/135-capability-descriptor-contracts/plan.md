# 实施计划

## 1. 描述符与校验

- 扩展 CapabilityDefinition，既有 10 项使用 version=1 和原 MCP 别名。
- 输入继续使用严格 additionalProperties=false；输出支持明确的受控安全记录投影。
- outputSchema 描述 Dispatcher 返回的 data；MCP 适配器组合成完整 Envelope Schema。
- 注册时检查 ID/别名唯一性、版本和必要策略。

## 2. Dispatcher 调用治理

- 按 Principal.source 检查 assistant/mcp/http exposure。
- targetResolver 声明 host/task/run/proposal 等目标；Dispatcher 对 host 引用做通用授权，领域适配器继续解析并复验非 host 资源。
- 在领域调用前后实施每能力大小、频率、并发和超时限制，拒绝和失败写安全审计。
- 领域结果先校验 data outputSchema，再构造既有响应 Envelope。

## 3. MCP 与错误兼容

- tools/list 使用 listPage 和 opaque cursor；默认页大小有界，目录或主体变化使旧 cursor 失效。
- outputSchema 包含 schema_version、invocation_id、kind、status、data。
- annotations 根据 effect/risk/operation_kind/idempotency 生成。
- 保留旧 error.code 分类，新增 detail_code；HTTP 以附加字段返回，MCP 保持统一安全错误正文。

## 4. 验证与交付

- 添加描述符、输出、曝光、目标、限制、错误和 MCP 分页测试。
- 复跑 SDD 134 核心测试及 MCP/授权/助手回归。
- 执行全仓类型检查、构建和 runtime 全量；main 既有失败单独对照。
- 更新系统设计、平台 MCP 架构和接入契约，推送 stacked 功能分支并创建面向 main 的 PR，注明依赖 #186，不合并。
