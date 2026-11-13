# 描述符与协议契约

## 描述符

`CapabilityDefinition` 至少包含：`id/version/name/description/inputSchema/outputSchema/scope/effect/risk/operationKind/exposure/executionMode/approvalPolicy/idempotencyPolicy/limits/resultProjection/auditPolicy/targetResolver/execute`。

- `id` 为稳定领域 ID，version 当前为 1；`name` 为既有 MCP 兼容别名。
- `effect` 当前只允许 read/propose；execute 不在本切片注册。
- `operationKind` 区分 center_read/telemetry_query/remote_probe/domain_change/long_running。
- exposure 分别控制 assistant/mcp/http；发现过滤不是唯一鉴权，invoke 必须再查。
- targetResolver 只声明目标，不授予权限。host 引用由 Dispatcher 校验，其他目标由领域适配器解析并复验。
- 默认限制为输入 16 KiB、完整响应 64 KiB、15 秒、每主体每能力 120 次/分钟和 4 并发；描述符可收紧。
- resultProjection 在输出 Schema 校验前执行；既有领域适配器已经返回安全视图，本切片使用显式恒等投影，不把原始存储对象新暴露给模型。auditPolicy=digest_only 保持只记录输入摘要，不记录脚本、秘密或原始输出。

## 输出

Dispatcher outputSchema 校验 `data`。MCP outputSchema 校验完整 structuredContent：

`{schema_version:1,invocation_id,kind,status,data}`。

文本 content 与 structuredContent 继续来自同一结果。输出非法或超限时不返回未经校验的数据；已持久提案仍通过原业务幂等键查询，不重复创建。

## 分页

`listPage(principal,cursor?,pageSize=50)` 返回 `{tools,nextCursor?}`。cursor 是无可读授权价值的 opaque base64url 数据，仅包含版本、offset、主体/凭据/grant/来源和目录摘要。服务器每页重新执行 Principal 校验与目录过滤；无效、越界、跨主体或目录变化返回 invalid_cursor。

## 错误

为兼容既有客户端，`error.code` 保留原分类，如 invalid_input/conflict/permission_denied。新增 `error.detail_code` 表示稳定细节，如 idempotency_conflict、capability_forbidden、output_invalid、rate_limited、concurrency_limit、timeout。

通用 HTTP 错误响应增加 code/detail_code，不删除 error 字段。MCP 继续使用安全通用消息和 retryable=false；detail_code 不包含秘密、SQL、路径或原始主机输出。

## 兼容与边界

既有工具名、Scope、输入和成功响应不变；outputSchema、cursor 和 detail_code 为增量能力。协议 request ID 不用于业务幂等，MCP cursor 不是业务游标或执行 ID。
