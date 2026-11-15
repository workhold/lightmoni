# SDD 165 契约

## 内部 `list_tables`

返回合法 JSON，字段为 `tables`、`limit`、`truncated`、`byte_limit`、`byte_limited`。每个摘要项保留 `id/name/kind`，存在服务信息时保留 `services`；不包含 `columns`。`byte_limit=12288`，完整结果序列化后不得超过该值。因字节预算省略后续表时 `truncated=true` 且 `byte_limited=true`。`describe_table` 的完整单表契约不变。

该约束只作用于内部助手适配层。`lightmoni_telemetry_catalog` 对 MCP 的 `columns` 投影、数量和权限保持不变。

## 查询样本

`TelemetryService.query` 继续使用统一 AST、范围和资源校验。`source=assistant` 时 `sample_byte_limit=16384`；`source=mcp` 时保持 `sample_byte_limit=61440`。达到字节预算而删减行时，`sample_truncated=true` 且 `sample_byte_limited=true`。

助手 SQL 必须包含语法正确的 `$__timeFilter(column)`，其中 column 是普通或点分标识符。缺失或形式错误时，在调用查询执行器前返回包含 `$__timeFilter` 的可纠正错误。MCP 不增加此项限制。

## 最后步骤

`prepareStep` 的 `stepNumber` 为 0 起始。`stepNumber >= max_steps - 1` 时返回 `toolChoice: "none"` 与空 `activeTools`。该步骤仍是正常模型请求，保留 preflight、流式文本、checkpoint、取消/超时和 request/usage 生命周期。只有获得有效最终输出且没有未完成工具调用时才写入 `done`；否则沿用真实错误码。

## 指令边界

页面上下文中的 `table` 是数据范围，不是新权限。已选表时直接 `describe_table`，不得因此跳过授权或 AST 校验。工具说明要求优先单表和已核验字段，不把 SQL 草稿、工具接受或部分成功查询声称为最终业务成功。
