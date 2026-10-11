# 公共开发契约 v1

2026-10-10，实施基线；2026-10-11 更新 Key 的指定/所有 table 上报范围协议。本文声明目标行为，代码与真实验收状态单独记录。主干拥有公共类型与入口；变更先协调消费者，不能各模块另造查询协议。

## 模块注册与前端边界

Go module 为 `github.com/lightmoni/lightmoni`。公共类型位于 `internal/shared/types.go`，依赖 `Dependencies{DB, Query, ReferencedTables, Catalog, ExternalURL, Encrypt, Decrypt}`；认证由主干中间件注入 User。模块推荐 `New(shared.Dependencies)` 返回模块，`Register(*http.ServeMux)` 注册 `/api/v1` 路由；需要 worker 的模块提供 `Run(context.Context)`。模块在构造阶段提交自身 SQLite 建表/迁移，主干控制初始化次序和进程取消。

前端使用 React/TypeScript、AntV G2、共享 Ant Design 基础控件及产品主题；所有 feature 输出默认 React 页面，主干注册路由。统一 `web/src/shared/api.ts` 和 `types.ts`，组件从 `web/src/shared/ui.tsx` 使用/重导出。禁止原生 select、window.alert/confirm/prompt；受控、带样式与校验的 Input 可以使用正常 HTML input。多个模块不得改 package.json、锁文件和应用壳。

## 采集协议与 Key

Key 管理：`POST /api/v1/keys` 请求 `{name, allowed_tables: ["web"]}`，选择所有 table 时请求 `{name, allow_all_tables: true}`，无需白名单；`GET /api/v1/keys` 返回 `allowed_tables`、`allow_all_tables`，不返回密钥明文；`PUT /api/v1/keys/{id}` 可更新 `name`、`active`、`allowed_tables`、`allow_all_tables`，省略的字段保持原值。指定 table 模式至少填写一个合法逻辑表名，最多 200 个；重复项去重。所有 table 模式保存 `allow_all_tables=true` 与空白名单，包含未来新表；切回指定模式需同时提供 `allow_all_tables=false` 与有效白名单。省略权限字段的重命名、启停保留当前模式。

OTLP/HTTP `/v1/logs`、`/v1/metrics`、`/v1/traces`，支持标准 Protobuf 与 OTLP JSON 编码，不能把私有 JSON 称为 OTLP。自有 SDK 一批只有一个 signal、一个 table、一个 service。资源含 `service.name`、`service.instance.id`；log 可带 `lightmoni.source_id` 与 `lightmoni.source_seq`，Agent 添加安装期间固定 host_id/agent_id。自定义属性不代替资源身份。

固定请求头：`X-Lightmoni-Table` 为逻辑表；`X-Lightmoni-Batch-ID` 为逐批 UUID；`X-Lightmoni-Batch-Created-At` 为冻结时 UTC RFC3339Nano。新窗口创建新 ID；重试保留 ID、创建时间和完全相同的解码 payload。同 ID 异正文拒绝。标准第三方 exporter 没有稳定批次 ID 时按至少一次兼容接入，其 SDK 级重试可能重复。

SDK 直连主服务使用 `Authorization: Bearer <key>`；SDK 到本机 Agent 不需要私有 Key。主服务支持多份命名上报 Key，保存摘要，完整秘密仅创建时显示。每份 Key 可上传任意 service，不绑定/限制 service，也不按 service 路由；每份 Key 通过 `allowed_tables` 精确匹配 `X-Lightmoni-Table`，或由管理员显式设置 `allow_all_tables=true` 允许所有合法逻辑表。默认全表权限为 false，未配置仍无写入授权。日志、指标、链路均在正文读取、建表、批次重放和写库之前检查，越权返回 403 并记录拒绝原因。Agent 配置一份 Key 转发授权范围内的业务；机器指标、拨测和目录日志使用分组指定的逻辑表，默认 `host`、`probe`、`files`。旧 Key 迁移为无 table 授权，管理员显式配置后恢复写入。禁用、失效、轮换、最近使用、上传量与拒绝原因必须可查看。所有记录的 key_id 由主服务认证取得，不信任采集正文。Key 轮换不改变已有批次 ID/记录 ID；重试同批时 first_key_id 归因保持首次接收，传输尝试另记实际尝试Key。

成功响应遵循对应 OTLP ExportResponse；自有链路整批校验、整批确认，不能用 partial_success 丢掉未知子集。Agent 先提交可恢复磁盘记录再 ACK；主服务等所有目标 ClickHouse 写入完成再 ACK。失败重试可能遇到部分已写行，但公开查询仍只计一次。兼容路径按 OTLP partial_success 规则处理。网络未知及 429/502/503/504 可重试；400 为永久协议拒绝；401/403 暂停等待修复凭证；其他状态按 OTLP 规范分类，不能所有 5xx 都盲目重试。

建议初始解压后每批不超过 4 MiB；最大补传年龄 24 小时，Agent receipt 与主服务批次元信息保留至少 48 小时，均为可统一调整配置。receipt 达到容量时背压，不能提前忘记仍在保证窗口的记录。同一批次首次 enrichment、摘要、created_at、first_received_at 持久化，已回收 spool 后重试仍保持相同转发正文；过去最大补传年龄后明确 expired，不宣称无限期重放。SDK 内存满的丢弃有诊断，已 ACK 的 Agent 数据不能默默删除。

## ClickHouse 数据模型

单库 `lightmoni`；逻辑名匹配 `[a-z][a-z0-9_]{0,47}`，不允许自填保留前缀 log_/metric_/trace_。系统按类型创建公开视图及内部表，限制总表数，service 不建独立表。公开名为 `log_<table>`、`metric_<table>_sum/gauge/histogram`、`trace_<table>`。

固定共用字段：`event_id String`、`event_time DateTime64(9,'UTC')`、`ingested_at DateTime64(9,'UTC')`、`service`、`instance_id`、`host_id`、`agent_id`、`key_id`、`resource_json`、`attributes Map(String,String)`、`attributes_json String`。attributes 供方便文本 SQL，attributes_json 保留 bool/int/double/string/null/结构的原类型，目录/日志过滤使用带类型访问，不把数字与字符串混淆。整数 JSON 无损编码；不能按每个新属性 ALTER TABLE。

- log：`severity String`、`severity_number UInt8`、`body String`、`body_json String`、`trace_id`、`span_id`、`source_id`、`source_seq Nullable(UInt64)`。OTLP缺事件时间时明确使用 observed_time 并标记时间来源，不伪造原始发生时间。
- sum：`name`、`unit`、`start_time`、`event_time` 为窗口结束、`value`（保留int/double类型）、`temporality`、`monotonic`。自有 Counter 为 monotonic Delta，查询 sum(value)；累计输入保留 temporality，不能直接当 Delta 相加。
- gauge：name/unit/value、点时间；点时间可能是 collection 时间，最新观测时间另有明确语义，不强称等于业务最后 record。
- histogram：name/unit/start_time/event_time、`bounds Array(Float64)`、`bucket_counts Array(UInt64)`、`count UInt64`、sum/min/max。边界严格递增、桶长=边界长+1、桶和=count。同边界分布才可合并。
- trace：trace_id/span_id/parent_span_id、name/kind、start_time/end_time/duration_ns、status、events_json、links_json；event_time=start_time。

主服务以 batch ID + signal + 原批记录位置生成稳定 event_id；重试不能因写入分表或顺序不同改变 ID。内部 `_lm_*` ReplacingMergeTree 使用固定原事件时间、service 与 event_id 作为完整排序键，按原事件日期分区。公开视图 `SELECT ... FINAL` 执行查询去重，禁止仅靠后台 merge。读账号只允许公开视图，使用已验证的 SQL SECURITY DEFINER；写/迁移账号分开，普通 SQL 不能读内部表或关闭去重。不向可能重试的原始插入直接挂 SUM 物化预聚合视图。开工先用真实 ClickHouse 验证合法视图、权限、丢 ACK/部分写入和计数。

主服务持久化 ACK 需要验证 ClickHouse part 写入与磁盘同步配置。首版批量同步写入基线评估 `fsync_after_insert`、`fsync_part_directory`；若采用异步插入，必须等待 flush，不能 ACK 内存队列。性能成本与硬件可靠性要实测，进程重启测试不代替掉电证明。[官方 fsync 设置](https://clickhouse.com/docs/reference/settings/merge-tree-settings/fsync)、[去重语义](https://clickhouse.com/docs/reference/engines/table-engines/mergetree-family/replacingmergetree)、[视图权限](https://clickhouse.com/docs/reference/statements/create/view)。

## 统一 SQL 请求与结果

`POST /api/v1/query` 使用 shared.QueryRequest。所有查询同一 UTC `[from,to)`，`interval_ms` 为固定正值；相对范围由界面/主干一次解析。每条查询含 refId、sql、params。参数 `{service:String}`、`{services:Array(String)}` 绑定值，不能文本插值或变量当任意表名。宏 `$__timeFilter(column)` 与 `$__timeInterval(column)` 唯一实现，解析必须避开注释/字符串，时间列为已验证字段标识符。

QueryResponse.results 每个 refId 独立 success/empty/error/cancelled，含 frames、complete、truncated、elapsed_ms。Frame 使用有类型 columns 与等长二维 rows；时间为 UTC RFC3339Nano，Int64/UInt64/Decimal 为字符串，有限浮点为 number，null 保留。图表转 number 需要显式精度策略，表格保持原值。扫描/内存超限失败，不接受扫描一半后的“精确”SUM；结果行上限可形成标明 truncated 的预览，告警拒绝此类结果。

仅允许单条只读 SELECT/WITH 查询，允许公开表间 JOIN/UNION。服务端校验实际表集合，拒绝 DDL/DML、多语句、外部 url/file/remote 表函数、系统表与内部表；数据库账号权限和硬上限独立兜底，不仅 startsWith('SELECT')。初始单请求最多 8 查询、单查询10秒/10,000结果行，资源预算可调整；网页查询与告警分开有界并发。取消必须传到数据库，错误不暴露凭证。

目录 `/api/v1/catalog/tables` 返回稳定 id/name/logical_name/kind/metric_type/columns/services/alert_group_id。模块通过 deps.Catalog 访问，不能自建目录。SQL样例由目录与实际schema生成，禁止模板引用不存在字段。

## 日志探索与联动

`/api/v1/logs/search`、histogram、field-values、context、tail、saved-searches 归日志模块，使用领域 typed QuerySpec。关键词是正文 UTF-8 不区分大小写字面子串；AND过滤；in列表内部OR。首版单表必有，显式多表可开放兼容类型。缺失、null、空字符串、0不同；ne/not_in只匹配存在且不等，exists只指键存在，null用显式 typed null比较。

历史结果按 event_time/event_id 排序，有界查询会话冻结已取行；初始每会话最多10,000行/16MiB、全局64MiB、TTL5分钟，容量或重启过期返回明确错误。首轮时间图独立全范围聚合并缓存，标注scope/generated_at；不声称与列表是数据库同瞬时事务快照。实时按ingested_at重叠轮询、event_id去重，初始3秒轮询/15秒重叠；超出可见延迟/恢复界限提示完整重查。详情与上下文按可信source身份，不混串同机服务。

跨模块草稿含 source_table_ids、sql、params、range或lookback、展示配置；LogExploreState、DashboardDraft、AlertRuleDraft 由公共类型注册，不能从任意SQL反推过滤。已保存对象revision乐观锁，更新冲突409；URL不包含Key、日志正文或provider秘密。

## 告警组、表配置与查询列表

AlertGroup{id,name,targets,revision}，target 为 channel_id + 类型化 recipient；机器人默认群、SMTP地址、短信手机号、pushplus接收绑定均显式表示。目录表绑定一个可空默认alert_group_id；规则声明source_table_ids，AST实际表集合必须相符。普通规则继承表组，跨表规则合并全部来源组目标按规范化(channel_id,recipient)去重。没有组或组无目标显示未路由，不能假装发送成功。采集时无需配置组才能上报。

组/规则/事件/outbox由告警模块维护；表绑定通过主干目录仓储写入。每次评估与outbox记录路由快照，组改目标不把历史队列发到新接收者；删除在用组需展示引用并先解绑。提供告警配置总览：表、service筛选、组、规则、启用状态及事件/发送记录；无规则的已绑定表也可见。规则自身保存窗口/固定变量，查询错误/无数据不能误发业务恢复。

## 用户、第三方登录与 AI

用户管理与会话主干负责；本地登录与 GitHub/微信/QQ/通用OAuth2提供配置入口、启用/禁用、账户绑定和错误处理。OAuth授权码在后端交换，state为一次性且绑定会话/用途；供应商支持时使用PKCE，OIDC使用nonce与token验证。外部稳定(provider,subject)唯一，不按昵称或未经验证email自动合并；管理员默认审核首次外部用户，保留本地管理员回退。通用OAuth2配置authorize/token/userinfo端点与subject映射，允许OIDC扩展。真实供应商需要用户配置注册应用与回调地址，未配置不显示可用成功路径。

AI参考Doca骨架移植会话、时间线、可取消SSE、工具loop与草稿审阅；provider配置由管理员填写、后端保管，不读本机其他项目密钥。工具仅通过公共Catalog/Query及只读日志接口执行有界分析；创建大盘、生成SQL/图表配置提供完整草稿与预览，用户点击自定义确认保存后调用相同CRUD。日志内容是数据，不能成为额外工具授权。AI模块负责会话/assistant UI与Go服务，主干注入查询与存储能力。

指标数值使用独立原始数值字段：`value_float` 保留 Float64，`value_int` 保留 Nullable(Int64)。公开 `value` 是便于绘图的 Float64；精确整数计数使用 `sum(toDecimal256(value_int,0))`。禁止在采集入口将极小浮点值舍入为零。旧原型内部 Decimal 列仅作兼容迁移，公开视图读取原始浮点，新表结构与已有表会在启动时同步。


## Agent 分组与目录日志

Agent 的任务以分组为单位，组内共用版本和任务。登录后 `GET /api/v1/agent-groups` 读取分组；管理员使用 `POST /api/v1/agent-groups`、`PUT /api/v1/agent-groups/{group}` 创建/修改名称及任务，`PUT /api/v1/agents/{id}/group` 改派机器。默认组不可删除，非空组不可删除。首次注册接受安装命令的 `group_id`；现有机器的注册和心跳不能覆盖平台保存的组。原有机器迁移到默认分组。

组配置包含 `host_enabled`、`host_collectors`、`collect_interval_seconds`、`process_names`、`host_table`，HTTP/TCP `probes` 与 `probe_table`，`logs_enabled`、`log_sources` 与 `log_table`。目录源指定绝对路径 `directory`、文件名规则 `pattern`、子目录开关 `recursive`、首次历史开关 `from_beginning`。平台用表单编辑，API 的 JSON 是传输协议，不要求用户编辑配置文件。Agent 通过原配置轮询接口读取所属组任务，先缓存再应用；首次取得有效任务前暂停内部采集，离线重启可用已缓存任务。

目录日志按换行增量读取，文件 device/inode 与 host 标识定位持久进度；读取位置、截断代次、文件头指纹和冻结批次在同一 SQLite 事务提交，背压不推进位置。文件重命名仍沿用进度，截断或文件头变化增加代次；copytruncate 在文件快速长回且前 64 字节完全相同的情况下无法可靠识别，建议使用重命名轮转。以 observed_time 表示采集时间，并标记 `event_time_source=observed`；`file_path`、`file_name` 保留来源，`lightmoni.source_id` 结合主机、文件与代次，`lightmoni.source_seq` 为行/分片的起始字节位置。未换行的短行等待续写，超长行按最多 64 KiB 分片并标记 `log_fragment=true`。已进队列的数据继续按其原表补传，改组不改写历史批次。
