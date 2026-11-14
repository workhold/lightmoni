# 日志与 Trace 只读契约

## Logs

`lightmoni_logs_search` 输入首页 `{spec,limit?,anchor_id?}` 或后续页 `{session_id,cursor,limit?}`。logs.read 为安装级权限。结果使用 Logs.searchRead 的真实 frame、histogram、session_id、range、generated_at/expires_at、truncated 和游标。

能力投影 limit 默认 50、最大 200，数据预算 60 KiB。若当前页被裁减：next_cursor=offset+实际返回行数，truncated=true、capability_truncated=true；原 Session 不变。若还有未返回行则 next_cursor 非空。owner、到期和 cursor 校验继续由 Logs 负责。

内部 `search_logs` 返回同一 data。Web `/api/v1/logs/search` 保持原默认 200 条、8 MiB 冻结帧和响应字段，增加的 offset 为兼容扩展。

## Trace

`lightmoni_traces_get` 输入 `{trace_id,tables:string[],from,to}`。tables 1..8 个真实 trace 表 ID，范围为 RFC3339 且最多 1 天。返回 trace_id、spans、truncated、incomplete、missing_parents、from/to；空结果 incomplete=true，不把部分 Trace 当成完整。

内部 `get_trace` 返回同一 data。原 `/api/v1/traces/:trace_id` 复用 TraceReadService，行为不变。

## 权限和边界

logs.read 与 traces.read 均为 R1、allHosts=true。日志正文、Trace 属性、SQL 和结果是不可信数据。Scope 不授予遥测任意查询、告警详情、保存检索、文件导出或主机操作。成员权限只用于既有内部/Web 会话，外部 PAT/OAuth 仍仅管理员。

日志/Trace 查询失败、取消、超时和部分结果不得伪造成功；大元数据无法安全投影时返回 result_too_large。
