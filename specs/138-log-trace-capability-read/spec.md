# 138 · 日志与 Trace 只读能力

状态：已实现，待 PR 审核。继承 SDD 046/047/134～137 和全平台能力开放 Goal。本切片从已合入的最新 main 开发，是 Slice 2 的日志/Trace 领域，不需要 stacked PR。

## 需求与范围

1. 将 Logs.search 的冻结会话、编译、执行、owner 和分页逻辑抽为 `Logs.searchRead(input, owner, signal)`；原 Web 路由只负责 body/user/response。
2. 新增 LogReadService 作为助手/MCP/HTTP 的有界投影，复用 Logs.searchRead，不复制日志 SQL 编译和会话状态机。
3. 新增 `lightmoni_logs_search` 与内部 `search_logs`，支持 filters/SQL 模式、首页和 session_id+cursor 后续页；原冻结帧、owner、2 分钟到期和 anchor 语义保持。
4. 抽取 TraceReadService，复用现有 Trace HTTP 的表校验、1 天范围、8 表、2000 span 和 missing parent 语义；新增 `lightmoni_traces_get` 与内部 `get_trace`。
5. 新增 `logs.read`、`traces.read`，二者均为安装级高敏读取，有限主机授权不能发现或调用；成员保留平台既有内部/Web 读取，外部 PAT/OAuth 仍只向管理员发 Scope。
6. 日志模型投影默认每页最多 50 条，并有 60 KiB 数据预算；裁剪只影响当前响应，不破坏原会话，后续 cursor 必须能读取被裁剪行。Trace 结果继续显式 truncated/incomplete。
7. 不新增告警/部署/运维写入，不开放保存检索写操作、通知、任意 SQL 或不受限日志导出。

## 非目标

- 不改变 SDK/Agent 上报、ClickHouse reader、日志冻结帧和 Trace 数据模型。
- 不提供主机级日志/Trace 隔离，不通过 SQL WHERE 冒充隔离。
- 不将日志/Trace 查询变成长期任务，不新增微服务或第二套查询。
- 不宣称大盘、部署或其他 Slice 2 领域已迁移。

## 验收

1. 原 logs/search Web 分页、owner、过期和 SQL 回归通过；新能力复用同一 Session Map。
2. 日志首页/后续页、filters/SQL、anchor、裁剪后续读取、大结果和错误均有测试；不会跳过被裁剪行。
3. Trace 原 HTTP 与新能力结果一致，非法表/范围、truncated 和 missing parent 如实返回。
4. logs.read/traces.read 相互独立，有限主机授权拒绝；成员内部读取不扩大外部权限。
5. 官方 MCP 客户端能发现、搜索/翻页和读取 Trace；无写入或审批工具新增。
6. 相关回归、类型检查、构建和 runtime 全量与 main 基线对比有真实记录。
