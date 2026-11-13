# 135 · 能力描述符与 MCP 契约完善

状态：已实现，已获授权合入 main。继承 SDD 046/047/134 和全平台能力开放 Goal，本切片交付 Slice 1。当前 stacked 基线包含 SDD 134；其 PR #186 未获合并授权，本切片独立创建面向 main 的 PR 并明确依赖，不自动合并。

## 需求与范围

1. 现有每项能力声明稳定 ID、major version、输入/输出 Schema、Scope、目标解析、effect、风险、操作类型、入口曝光、同步方式、审批/幂等和调用限制。
2. Dispatcher 在调用时执行入口曝光、目标声明校验、每能力输入/输出大小、超时、频率和并发限制；输出在返回前校验 data Schema。
3. MCP tools/list 广告完整 structuredContent Envelope 的 outputSchema，annotations 从描述符派生；协议注解不构成授权。
4. MCP tools/list 支持有界、opaque cursor 分页。游标绑定当前主体、凭据/grant、来源和工具目录摘要，后续页重新鉴权，不携带权限。
5. 保留既有工具名、Scope、输入、成功响应和错误 `code` 分类；新增稳定 `detail_code`，例如旧 `conflict` 对应的 `idempotency_conflict`。
6. 通用能力 HTTP 增加兼容的错误 code/detail_code；既有 Web 领域 API 不变。
7. 本切片不增加业务领域工具，不开放 execute、审批、任意 SQL/Shell、服务主体或持续授权。

## 非目标

- 不扩展遥测行、日志、Trace、部署、运维或 Agent 生命周期工具。
- 不改变 MCP 协议版本、PAT/OAuth 格式和客户端支持声明。
- 不把所有现有 Web API 改为通用 Capability API。
- 不声称长任务异步化、代码任务持久化或跨领域索引已经完成。

## 验收

1. 10 个既有能力的描述符字段完整且注册表拒绝重复/非法定义；成功响应保持兼容。
2. 无权限入口不能通过直接 invoke 绕过 exposure；目标 host 声明和原领域资源检查都生效。
3. 输出 Schema 同时约束 Dispatcher data 和 MCP structuredContent Envelope；非法输出返回 output_invalid，不泄露原始数据。
4. tools/list 分页可遍历、不错漏，失效/伪造/跨主体/目录变化 cursor 被拒绝；每页重新刷新权限。
5. 每能力大小、超时、频率、并发限制有测试；断连和既有业务幂等语义不变。
6. 旧错误 code 保持兼容，新增 detail_code 精确且安全；HTTP 与 MCP 不错误泄露内部错误。
7. 相关回归、类型检查、构建和 runtime 全量与 main 基线对比均有真实记录。
