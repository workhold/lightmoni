# 遥测只读契约

## 能力

- `lightmoni_telemetry_catalog`：`telemetry.catalog.read`，返回既有安全目录，limit=100。
- `lightmoni_telemetry_describe`：输入 `{table}`，按稳定 ID 或名称读取一个目录表，返回 `{table}`。
- `lightmoni_telemetry_query`：输入 `{sql,range:{from,to},interval_ms,params?}`，返回 `{query,range,sample_limit:1000,sample_truncated,sample_byte_limit,sample_byte_limited}`。

三项均 allHosts=true。host_ids=[]、有限主机列表或普通成员外部凭据不获得安装级遥测数据。Scope 发现过滤不是唯一鉴权，invoke 再查。

## 查询

领域服务校验单条 SQL 非空且不超过 16000 字节、interval_ms 为正安全整数、RFC3339 UTC offset 时间、from<to 且范围不超过 90 天。params 为对象，每项仅含 type/value。实际 SQL 安全继续由既有 Executor/Query 负责，包括单 SELECT、目录表、宏、参数和只读 reader。

领域 Query 使用 10 秒 AbortSignal，能力层另执行 15 秒期限、30 次/分钟和 2 并发。查询返回一个 result；error/cancelled 不转换成成功。采样先限制 1000 行，再按 60 KiB 数据预算缩小行集合，任何删除都设置 sample_truncated=true，并区分 sample_byte_limited。

## 角色与来源

内部助手保留 list_tables/describe_table/run_query 名称，实际调用对应能力。Principal.source 传入 Query 的 source，能力调用审计记录真实 assistant/mcp/web。

管理员会话具有全部能力 Scope；成员会话只具有 telemetry.catalog.read/telemetry.query，且其他描述符仍要求 admin。外部 PAT/OAuth 的可授予 Scope 继续只对管理员开放，不因成员内部读取而扩大。

## 兼容与边界

既有 catalog 工具名称和响应不变。内部旧工具返回其既有外层形态，describe 适配器解包 data.table。SDK/Agent 上报协议不变；本能力只读查询，不返回连接凭据，不提供写 SQL 或任意服务调用。
