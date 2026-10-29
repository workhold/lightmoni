# 公共开发契约 v1

2026-10-10 实施基线；2026-10-11 更新 Key 权限；2026-10-17 依 [SDD 007](../specs/007-node-runtime-migration/spec.md) 将中心和 Agent 统一为 Node.js / TypeScript；2026-10-18 依 [SDD 009](../specs/009-assistant-alert-controls/spec.md) 增加共享告警能力与人工确认提案；2026-10-19 依 [SDD 015](../specs/015-data-access-management/contracts.md) 整理接入凭据与数据管理；2026-10-29 依 [SDD 038](../specs/038-registered-host-agent-onboarding/spec.md) 将 Agent 接入统一为登记主机的平台部署流程，移除旧身份兼容。早期任务和证据中的 Go 平台实现属于迁移前历史。本文声明目标行为，代码与真实验收状态单独记录。主干拥有公共类型与入口；变更先协调消费者，不能各模块另造查询协议。

## 模块注册与前端边界

中心和 Agent 的公共类型位于 `runtime/src/shared/types.ts`。模块使用 `Dependencies` 注入 SQLite `db`、统一 `query`、SQL AST `referencedTables`、`cat`、ClickHouse writer/reader、`auth`、`router`、`externalURL`、`encrypt/decrypt`、时钟和 logger；认证由 Router 注入 `Context.user`。模块通过注入的 Router 注册 `/api/v1` 路由并返回 `Module`，提供可选 `start()` / `close()`；后台任务使用 AbortSignal 传播取消，关闭时清除定时器并等待已启动的工作结束。模块在构造阶段提交自身 SQLite 建表/迁移，`runtime/src/server/app.ts` 控制初始化和关闭次序。

中心功能分布在 `runtime/src/server`、`domains`、`assistant`；Agent 位于 `runtime/src/agent`。2026-10-20按用户指定保留本地业务SDK与中心上报逻辑：接入页提供Go、TypeScript/Node.js、Rust、Python四种record SDK；其他历史语言保留兼容源码。Go module `github.com/workhold/lightmoni` 仅供保留的 Go SDK 源码使用，不是中心或 Agent 的启动入口。生产发布固定 Node 24.15.0，Linux Agent 自带 Node 双架构包且要求 glibc ≥ 2.28。

前端使用 React/TypeScript、AntV G2、共享 Ant Design 基础控件及产品主题；所有 feature 输出默认 React 页面，主干注册路由。统一 `web/src/shared/api.ts` 和 `types.ts`，组件从 `web/src/shared/ui.tsx` 使用/重导出。禁止原生 select、window.alert/confirm/prompt；受控、带样式与校验的 Input 可以使用正常 HTML input。多个模块不得改 package.json、锁文件和应用壳。

## 采集协议与 Key

SDK上报密钥管理：POST /api/v1/keys只要求{name}，启用的有效密钥可写任意业务表；完整明文仅在创建响应中返回。旧allowed_tables/allow_all_tables输入经类型校验后忽略，输出统一allowed_tables=[]/allow_all_tables=true。PUT支持名称与启停，上报记录仍通过/keys/{id}/events读取。SDK接入页保留SDK样例、SDK密钥、豁免表三个页签；管理后台的SDK凭据入口复用同一规则。

OTLP/HTTP `/v1/logs`、`/v1/metrics`、`/v1/traces`，支持标准 Protobuf 与 OTLP JSON 编码，不能把私有 JSON 称为 OTLP。自有 SDK 一批只有一个 signal、一个 table、一个 service。资源含 `service.name`、`service.instance.id`；log 可带 `lightmoni.source_id` 与 `lightmoni.source_seq`，Agent 添加安装期间固定 host_id/agent_id。自定义属性不代替资源身份。

固定请求头：`X-Lightmoni-Table` 为逻辑表；`X-Lightmoni-Batch-ID` 为逐批 UUID；`X-Lightmoni-Batch-Created-At` 为冻结时 UTC RFC3339Nano。新窗口创建新 ID；重试保留 ID、创建时间和完全相同的解码 payload。同 ID 异正文拒绝。标准第三方 exporter 没有稳定批次 ID 时按至少一次兼容接入，其 SDK 级重试可能重复。

SDK直连主服务使用Authorization: Bearer <SDK key>。有效启用密钥可写所有合法业务表；旧密钥保留身份并采用同一业务表写入规则。缺失Authorization仅允许实时启用的豁免表；错误/空凭据返回401，不降级匿名。豁免表按管理员配置即时校验，匿名SDK不上报自身遥测。SDK Key与Agent专用control/data凭据保持分离。

Agent 只能从登记主机的平台部署流程接入：中心内部签发 enrollment 时强制绑定已登记 `machine_id`，公共独立签发接口返回 409，手工关联接口移除。安装器经 SSH stdin 接收短期 token，不进入 URL、argv、环境变量、日志或 AI 上下文；兑换、激活、注册/心跳核验主机预约及独立身份，注册不创建资产或抢占其他主机。`host_id` 是 Agent 遥测资源 ID，不代替平台主机 ID；名称、出口 IP 不能作为自动关联证据。无主机预约的旧 token/Agent、共享 SDK Key 控制面 fallback 不再支持，不自动迁移或删除历史资产。

中心签发绑定 `agent_id` 的 `control_credential` 与 `data_credential`，control 仅用于心跳/配置等控制请求，data 仅用于遥测，二者不能互换。Agent 上报带 `X-Lightmoni-Agent-ID` 和 data Bearer，允许合法业务逻辑表；机器指标、拨测和目录日志固定逻辑表为 `host`、`probe`、`files`。`/downloads/agent/*` 仅使用该主机安装会话的有效 enrollment 下载授权，SDK Key 和节点 control/data 不代替安装令牌。

SDK 默认直连中心，不要求主机登记或 Agent。显式使用本机 Agent OTLP 接收能力时不持有中心秘密，使用由目标 Agent 本地配置管理的 `local_token`，非 loopback 监听必须启用。Agent 向中心拉取配置强制使用独立 control；SDK 直连 `/v1/sdk-config` 使用 SDK Key，不因 Agent 控制凭据收敛改变 SDK 数据权限。

所有记录的 key_id 由主服务认证取得，不信任采集正文；Agent 记录 data credential ID，SDK 记录 SDK Key ID。凭据轮换不改变已有批次 ID/记录 ID，同批重试保留首次接收的 first_key_id，传输尝试另记实际凭据 ID。

成功响应遵循对应 OTLP ExportResponse；自有链路整批校验、整批确认，不能用 partial_success 丢掉未知子集。Agent 先提交可恢复磁盘记录再 ACK；主服务等所有目标 ClickHouse 写入完成再 ACK。失败重试可能遇到部分已写行，但公开查询仍只计一次。兼容路径按 OTLP partial_success 规则处理。网络未知及 429/502/503/504 可重试；400 为永久协议拒绝；401/403 暂停等待修复凭证；其他状态按 OTLP 规范分类，不能所有 5xx 都盲目重试。

建议初始解压后每批不超过 4 MiB；最大补传年龄 24 小时，Agent receipt 与主服务批次元信息保留至少 48 小时，均为可统一调整配置。receipt 达到容量时背压，不能提前忘记仍在保证窗口的记录。同一批次首次 enrichment、摘要、created_at、first_received_at 持久化，已回收 spool 后重试仍保持相同转发正文；过去最大补传年龄后明确 expired，不宣称无限期重放。SDK 内存满的丢弃有诊断，已 ACK 的 Agent 数据不能默默删除。

## 接入与管理页面

SDK 接入位于 `/data?tab=sdk|keys|exempt`。主机是唯一受管资产，Agent 安装只从 `/machines` 的登记、预检和部署计划发起，无独立脚本安装页面。主机列表按平台主机 ID 展示，Agent 补充通道和任务；成员仅可查看已关联主机 ID/名称和原有 Agent 可见信息，不获得 SSH 元数据。主机 ID 不可修改，名称及完整 SSH 连接可编辑；有效 Agent 身份须先移除再删主机，移除/卸载不删除资产。

主机登记同屏展示主机名、地址、端口、用户名、登录方式、密码或私钥输入、保存时长，默认密码登录、保存 6 小时。主机公钥、指纹与记录时间由首次 SSH 握手自动固定，主机写 API 拒绝人工身份字段；后续连接自动比对，公钥和指纹在管理员详情只读展示，不需要用户填写或确认；指纹和主机 ID/名称是资产元数据，不受登录凭据有效期影响。登记与凭据保存可使用两个请求，但凭据保存失败必须保留已创建主机 ID 就地重试，不重复建档或执行 SSH。关闭重开或切换登录方式清除秘密输入；也允许明确只登记、稍后添加凭据。登记和添加凭据共用同一套字段，详见 [SDD 039](../specs/039-host-registration-credential-retention/spec.md)。

`POST /api/v1/machines/:id/credentials` 的密码/私钥共用保存策略：有限保存 `retention=managed`，默认 `expires_in_seconds=21600`、最长 365 天，保存操作提交 `confirm_managed=true`；永久保存为 `retention=permanent`，要求显式 `confirm_permanent=true` 且禁止同时提交 `expires_in_seconds`，返回 `expires_at=''` 表示没有固定过期时间，不使用远期时间戳。统一有效性为未撤销、秘密未清除且为永久策略或有限 `expires_at` 晚于当前时间；空或非法有限期不得视为永久。到期/撤销清除秘密并使终端失效，永久仅主动撤销后清除；Agent 激活不清除 managed/permanent。原有 temporary 与 one_time 仍按既有到期、激活或使用结束策略处理，不再作为当前登记默认。秘密加密存储、不回显，不进入 AI、日志、审计或计划；建议优先短期保存。终端、SSH 检查、单机/批量安装与卸载使用同一有效性规则。

管理员在 `/admin?tab=credentials&section=sdk|enrollments|agents` 查看三类凭据；enrollment 页面只保留平台部署会话的审计与撤销，不单独签发。`GET /api/v1/agent-enrollments` 与 `GET /api/v1/agent-credentials` 各展示最近最多 200 条白名单元数据，不返回秘密、哈希、bootstrap 或 nonce；GET 不写状态。`POST /api/v1/agent-enrollments/:id/revoke` 可撤销尚未完成的会话。节点凭据撤销按 Agent 与 audience 影响该用途全部未撤销凭据，须确认影响，恢复通过主机的新部署流程。

独立 `/data-management` 保留表目录、服务、类型和保留时长；成员只读，管理员可改单表时长及日志采样/停报规则。全局 SDK 停报仍从 SDK 接入页进入，图表模板保留在监控大盘。/data?tab=keys为SDK密钥管理；旧tables/templates分别跳转数据管理与监控大盘。模板 API 继续用于大盘，采集协议及已有表权限不变。完整路由和响应约束见 [SDD 015 契约](../specs/015-data-access-management/contracts.md)。

## ClickHouse 数据模型

单库 `lightmoni`；逻辑名匹配 `[a-z][a-z0-9_]{0,47}`，不允许自填保留前缀 log_/metric_/trace_。系统按类型创建公开视图及内部表，限制总表数，service 不建独立表。公开名为 `log_<table>`、`metric_<table>_sum/gauge/histogram`、`trace_<table>`。

固定共用字段：`event_id String`、`event_time DateTime64(9,'UTC')`、`ingested_at DateTime64(9,'UTC')`、`service`、`instance_id`、`host_id`、`agent_id`、`key_id`、`resource_json`、`attributes Map(String,String)`、`attributes_json String`。attributes 供方便文本 SQL，attributes_json 保留 bool/int/double/string/null/结构的原类型，目录/日志过滤使用带类型访问，不把数字与字符串混淆。整数 JSON 无损编码；不能按每个新属性 ALTER TABLE。

- log：`severity String`、`severity_number UInt8`、`body String`、`body_json String`、`trace_id String`、`span_id String`、`source_id`、`source_seq Nullable(UInt64)`。trace/span 是独立的可选关联字段；SDK 请求/任务作用域内自动关联，业务可不逐条传 trace 上下文。无上下文时 OTLP 可省略字段，入库固定列写空字符串，不能为单条日志生成 trace 或从同名自定义属性推断。关联在日志调用时捕获，冻结重试保持原值；跨服务传播 W3C traceparent/tracestate，下游保持同一 trace ID 并创建自己的 span ID，详见 [SDK 约定](../sdk/README.md#日志-trace-字段预留)。OTLP缺事件时间时明确使用 observed_time 并标记时间来源，不伪造原始发生时间。
- sum：`name`、`unit`、`start_time`、`event_time` 为窗口结束、`value`（保留int/double类型）、`temporality`、`monotonic`。自有 Counter 为 monotonic Delta，查询 sum(value)；累计输入保留 temporality，不能直接当 Delta 相加。
- gauge：name/unit/value、点时间；点时间可能是 collection 时间，最新观测时间另有明确语义，不强称等于业务最后 record。
- histogram：name/unit/start_time/event_time、`bounds Array(Float64)`、`bucket_counts Array(UInt64)`、`count UInt64`、sum/min/max。边界严格递增、桶长=边界长+1、桶和=count。同边界分布才可合并。
- trace：trace_id/span_id/parent_span_id、name/kind、start_time/end_time/duration_ns、status、events_json、links_json；event_time=start_time。

主服务以 batch ID + signal + 原批记录位置生成稳定 event_id；重试不能因写入分表或顺序不同改变 ID。内部 `_lm_*` ReplacingMergeTree 使用固定原事件时间、service 与 event_id 作为完整排序键，按原事件日期分区。公开视图 `SELECT ... FINAL` 执行查询去重，禁止仅靠后台 merge。读账号只允许公开视图，使用已验证的 SQL SECURITY DEFINER；写/迁移账号分开，普通 SQL 不能读内部表或关闭去重。不向可能重试的原始插入直接挂 SUM 物化预聚合视图。开工先用真实 ClickHouse 验证合法视图、权限、丢 ACK/部分写入和计数。

主服务持久化 ACK 需要验证 ClickHouse part 写入与磁盘同步配置。首版批量同步写入基线评估 `fsync_after_insert`、`fsync_part_directory`；若采用异步插入，必须等待 flush，不能 ACK 内存队列。性能成本与硬件可靠性要实测，进程重启测试不代替掉电证明。[官方 fsync 设置](https://clickhouse.com/docs/reference/settings/merge-tree-settings/fsync)、[去重语义](https://clickhouse.com/docs/reference/engines/table-engines/mergetree-family/replacingmergetree)、[视图权限](https://clickhouse.com/docs/reference/statements/create/view)。

## 统一 SQL 请求与结果

`POST /api/v1/query` 使用 `runtime/src/shared/types.ts` 的 `QueryRequest`。所有查询同一 UTC `[from,to)`，`interval_ms` 为固定正值；相对范围由界面/主干一次解析。每条查询含 refId、sql、params。参数 `{service:String}`、`{services:Array(String)}` 绑定值，不能文本插值或变量当任意表名。宏 `$__timeFilter(column)` 与 `$__timeInterval(column)` 唯一实现，解析必须避开注释/字符串，时间列为已验证字段标识符。

QueryResponse.results 每个 refId 独立 success/empty/error/cancelled，含 frames、complete、truncated、elapsed_ms。Frame 使用有类型 columns 与等长二维 rows；时间为 UTC RFC3339Nano，Int64/UInt64/Decimal 为字符串，有限浮点为 number，null 保留。图表转 number 需要显式精度策略，表格保持原值。扫描/内存超限失败，不接受扫描一半后的“精确”SUM；结果行上限可形成标明 truncated 的预览，告警拒绝此类结果。

仅允许单条只读 SELECT/WITH 查询，允许公开表间 JOIN/UNION。服务端校验实际表集合，拒绝 DDL/DML、多语句、外部 url/file/remote 表函数、系统表与内部表；数据库账号权限和硬上限独立兜底，不仅 startsWith('SELECT')。初始单请求最多 8 查询、单查询10秒/10,000结果行，资源预算可调整；网页查询与告警分开有界并发。取消必须传到数据库，错误不暴露凭证。

目录 `/api/v1/catalog/tables` 返回稳定 id/name/logical_name/kind/metric_type/columns/services/alert_group_id。模块通过注入的 `cat: Catalog` 访问，不能自建目录。SQL样例由目录与实际schema生成，禁止模板引用不存在字段。

## 日志探索与联动

`/api/v1/logs/search`（含独立 histogram）、`aggregate`、`context`、`tail`、详情和 `saved-searches` 归日志模块，使用领域类型化检索规格。关键词是正文 UTF-8 不区分大小写字面子串；AND过滤；in列表内部OR。首版单表必有，显式多表可开放兼容类型。缺失、null、空字符串、0不同；ne/not_in只匹配存在且不等，exists只指键存在，null用显式 typed null比较。

历史结果按 event_time/event_id 排序，有界查询会话冻结已取行；当前每会话最多2,000行、列表与时间图共用8MiB预算、全局最多32会话/32MiB、TTL2分钟，容量或重启过期返回明确错误。首轮时间图独立全范围聚合并缓存，标注scope/generated_at；不声称与列表是数据库同瞬时事务快照。实时按ingested_at重叠轮询、event_id去重，初始3秒轮询/15秒重叠；超出可见延迟/恢复界限提示完整重查。详情与上下文按可信source身份，不混串同机服务。

跨模块草稿含 source_table_ids、sql、params、range或lookback、展示配置；LogExploreState、DashboardDraft、AlertRuleDraft 由公共类型注册，不能从任意SQL反推过滤。已保存对象revision乐观锁，更新冲突409；URL不包含Key、日志正文或provider秘密。

## 告警组、表配置与查询列表

AlertGroup包含id/name/enabled/revision、用户members、primary/backup/fallback、timezone、channel_ids、schedule和P0～P3 policies。schedule支持fixed/daily/weekly/custom和临时overrides。系统渠道保存供应商秘密；NotificationProfile保存邮箱、E.164手机号、feishu_id/dingtalk_id/wecom_id与来源。组策略解析当前主备，生成不可改投的接收人快照。

目录表绑定一个可空默认alert_group_id；规则声明source_table_ids，AST实际表集合必须相符。显式group_ids优先，否则继承来源表组；每个episode+group_id只建立一个响应，多组分别接手。unclaimed/acknowledged/resolved/cancelled与业务条件状态分开。接手原子保存owner、来源、时间及期限，取消待发送任务；周期提醒不重建响应。规则暂停/恢复保留episode，判断变化取消旧响应，表路由变更无需提醒即可重建责任关系。

系统渠道type包括webhook/feishu/feishu_app/dingtalk/wecom/pushplus/smtp/aliyun_sms/tencent_sms/huawei_sms/aliyun_voice/tencent_voice。普通群机器人、短信、邮件使用专门接手链接，登录到达告警页后POST；GET不接手。飞书应用卡片经操作者身份校验回调接手，电话接听即接手。受理、投递、接听、接手各自记录。接口、静默、有效时钟、现场限制、统计定义和Hook JSON见[告警响应](alert-response.md)；接入配置见[通知渠道](notification-channels.md)。

组/规则/事件/响应/outbox由告警模块维护；表绑定由目录仓储写入。静默和窗口外暂停通知及无人响应计时，P2按P1通知仍检查P1窗口。组策略保存快照，开放事件显式replan应用当前配置；删除在用组先解绑。联系方式/成员/接入变更发送前再次校验，不改投历史队列。SQL查询错误、无数据不能误发业务恢复。

## 用户、第三方登录与 AI

用户管理与会话主干负责；本地登录与 GitHub/微信/QQ/通用OAuth2提供配置入口、启用/禁用、账户绑定和错误处理。OAuth授权码在后端交换，state为一次性且绑定会话/用途；供应商支持时使用PKCE，OIDC使用nonce与token验证。外部稳定(provider,subject)唯一，不按昵称或未经验证email自动合并；管理员默认审核首次外部用户，保留本地管理员回退。通用OAuth2配置authorize/token/userinfo端点与subject映射，允许OIDC扩展。真实供应商需要用户配置注册应用与回调地址，未配置不显示可用成功路径。

AI参考Doca骨架移植会话、时间线、可取消SSE、工具loop与草稿审阅；provider配置由管理员填写、后端保管，不读本机其他项目密钥。工具仅通过公共Catalog/Query及只读日志接口执行有界分析；创建大盘、生成SQL/图表配置提供完整草稿与预览，用户点击自定义确认保存后调用相同CRUD。日志内容是数据，不能成为额外工具授权。AI模块负责会话/assistant UI与中心 TypeScript 服务，主干注入查询与存储能力。

指标数值使用独立原始数值字段：`value_float` 保留 Float64，`value_int` 保留 Nullable(Int64)。公开 `value` 是便于绘图的 Float64；精确整数计数使用 `sum(toDecimal256(value_int,0))`。禁止在采集入口将极小浮点值舍入为零。旧原型内部 Decimal 列仅作兼容迁移，公开视图读取原始浮点，新表结构与已有表会在启动时同步。


## LightMoni Agent、执行节点与任务标签（2026-10-17）

LightMoni Agent 是主机上的管理通道，一个运行实例内部称“执行节点”，统一从主机管理接入和查看；Collector/采集器是内部功能。“任务”是独立配置和启停的指标采集、服务拨测或目录日志工作，“任务标签”用于分发。节点和任务均可关联多个标签，任一标签相交即可命中，同一任务只下发一次。空目标不广播；节点无匹配任务时关闭内部采集和拨测，仍可接收业务 OTLP，并按独立节点 data 凭据授权转发；共享 SDK Key 不授予 Agent 控制权。现有网页对话继续称“AI 助手”；本功能未增加节点智能执行或任意命令能力。

登录用户通过 `GET /api/v1/agent-task-labels`、`GET /api/v1/agent-tasks` 读取标签和任务；管理员使用各资源的 POST、PUT/DELETE `/{id}` 管理，使用 `PUT /api/v1/agents/{id}/labels` 的 `{label_ids:[]}` 设置节点标签。默认标签和仍被引用的标签不能删除。节点列表增加 `label_ids/labels/task_ids/tasks`，`config` 是最终有效配置。写入在事务内验证所有实际受影响节点；上报表、采集间隔或同 ID 拨测等配置冲突返回 409，整个更新回滚，旧配置保持。读取需登录，变更需管理员。

指标任务包含 `host_collectors`、`collect_interval_seconds`、`process_names`、`host_table`，拨测任务包含 HTTP/TCP `probes` 与 `probe_table`，目录日志包含 `log_sources` 与 `log_table`。目录源指定绝对路径 `directory`、文件名规则 `pattern`、子目录开关 `recursive`、首次历史开关 `from_beginning`。平台使用类型对应表单，中心将匹配任务合成为原有 RemoteConfig，已认证 Agent 通过控制配置轮询接口读取，先缓存再应用；首次取得有效任务前暂停内部采集，离线重启可用已缓存任务。详情见 [接口与合并约束](../specs/006-execution-nodes/contracts.md)。

早期 SDD 006 中的分组迁移和旧任务接口属于任务配置历史，不授予新接入权限。当前 Agent 必须满足 SDD 038 的主机预约和独立身份契约；部署计划选择初始标签，后续通过任务标签接口管理，重新注册和心跳不能覆盖中心标签。

目录日志按换行增量读取，文件 device/inode 与 host 标识定位持久进度；读取位置、截断代次、文件头指纹和冻结批次在同一 SQLite 事务提交，背压不推进位置。文件重命名仍沿用进度，截断或文件头变化增加代次；copytruncate 在文件快速长回且前 64 字节完全相同的情况下无法可靠识别，建议使用重命名轮转。以 observed_time 表示采集时间，并标记 `event_time_source=observed`；`file_path`、`file_name` 保留来源，`lightmoni.source_id` 结合主机、文件与代次，`lightmoni.source_seq` 为行/分片的起始字节位置。未换行的短行等待续写，超长行按最多 64 KiB 分片并标记 `log_fragment=true`。已进队列的数据继续按其原表补传，调整任务或标签不改写历史批次。

### Mastra AI runtime（2026-10-14；2026-10-17 更新平台实现）

生产 Agent loop 使用 Mastra Node worker，由 Node 中心通过私有管道启动和取消。中心 TypeScript 模块保持 Actor、配置密钥、Store、Catalog/Query 和草稿的唯一权威。来源与许可参考详见 specs/001-mastra-assistant/research.md。会话增加 summary/summary_through；原始 Messages 保留，模型输入为摘要和未压缩后缀。旧会话和配置可直接读取。配置新增 max_input_tokens/max_output_tokens/max_steps，缺省 32000/4096/8。输入预算是保守字节估计，并检查每次模型调用的 prompt 和 tool schemas；历史按完整轮次整理，单轮过大明确失败。事件增加 context.compacting/context.compacted 和 turn.usage；usage 仅记录供应商 raw usage 中实际提供的字段，phase 区分 compact/execute。文本 SSE 实时发送；SQLite 写入以 250ms 批处理且合并相邻历史 delta，边界和终态立即持久化。工具仍只读或 draft，后台恢复及自动修改不属于本次契约。

### AI model discovery (2026-10-14)

管理员通过 `POST /api/v1/assistant/models` 使用未保存的 `base_url`、`api_key`、`protocol` 和明确的 `use_saved_key` 查询目录。已保存密钥只能在完整规范 API 基地址匹配时复用；配置 PUT 同样禁止跨地址自动保留旧密钥。同地址切换协议可复用。协议支持 `openai-chat-completions`、`openai-responses`、`anthropic-messages`、`google-generative-ai`；配置必须保存具体协议，旧配置缺省 Chat。目录输入缺省 `auto`，响应返回建议、候选协议、依据及是否须确认，始终 `capabilities_verified:false`。未知 OpenAI 兼容目录（即使返回 Gemini 风格的 `models[].name`）须人工区分 Chat/Responses；只有成功使用 Google profile 或可信 Google 地址/路径时才推荐 Gemini，不按模型名称推断协议。

目录使用 Bearer、Anthropic `x-api-key` 或 Gemini `x-goog-api-key`，密钥不进入 URL。最多 7 个同源 GET，总超时 8 秒、禁止重定向、每个响应最大 1 MiB，返回排序去重的最多 500 个模型。使用新填写的 Key 或无需 Key 时，OpenAI/Anthropic 根地址依次尝试 `/v1`、根地址，Google 依次尝试 `/v1`、`/v1beta`、根地址；复用已保存 Key 不回退。各协议集中维护版本修正、目录鉴权和查询参数，获取模型、测试连接及配置 PUT 复用协议地址规范化。OpenAI/Anthropic 仅把独立末段 `/v1beta` 修为 `/v1`，Google 保留显式版本，自定义前缀和转义路径保持；修正不能迁移旧密钥的实际存储地址。401/403 仍表示凭据问题，不能被后续候选路径的失败覆盖。分页仅标记截断，不跟随下一页。查询不持久化、不调用生成、错误不包含远端正文。设置页提供自动查询、独立获取按钮及手动模型输入，成功后回填实际可用的规范 Base URL，地址/Key/协议变更或关闭窗口会取消旧查询。规格、接口和验证见 specs/003-multi-protocol-models。

管理员可通过 `POST /api/v1/assistant/test-connection` 主动验证具体协议、模型和可选的 `reasoning_effort`（`provider-default`、`none`、`minimal`、`low`、`medium`、`high`、`xhigh`；缺省跟随供应商）。请求必须包含合法 Base URL、具体协议和非空模型，可带新 Key 或仅在规范 Base URL 完全一致时复用已保存 Key。前端自动模式只有当前目录唯一确定协议后才提交该具体协议。服务使用 Mastra runtime 发送一次固定短提示词的最小真实请求（无工具、4096 输入 token、总输出预算最多 256 token、最多 1 步、15 秒超时），在实际 SDK 请求体上检查预算，保留所选思考深度；无法容纳的思考预算在发出请求前返回 422 / `test_budget_exceeded`。供应商有效响应因输出预算耗尽返回 502 / `output_limit`，请求状态仍为 succeeded，已报告用量保留。丢弃生成正文，请求生命周期和实际 usage 写入独立用量账本，不创建会话、不保存连接配置。成功只返回 `ok`、实际 Base URL、协议、模型和耗时；输入/密钥地址不匹配返回 400，超时返回 504，其他运行时或供应商错误返回不含上游正文的 502。目录刷新仍是只读操作，只有点击测试连接才可能产生供应商费用。

### Model management and billing (2026-10-17)

设置入口改名“模型管理”，保留 `/admin?tab=models`。管理员使用 `GET/PUT /api/v1/assistant/billing` 读取/保存当前连接的 `currency`（CNY/USD）、可空 `input_price_per_million` 与 `output_price_per_million`，并提交 `base_url/protocol/model` 身份。身份过期返回 409；价格有限且在 0–1e9 范围，null 未知、0 免费。保存价格不更改连接或密钥，连接身份不同的价格独立保存。

`GET /api/v1/assistant/usage?days=7|30|90&timezone=Asia/Shanghai` 仅管理员可读，默认 30 天/UTC，采用包含今天的日历日范围（from 含、to 不含）。响应 totals/daily/models/sources 分别提供已知 token 合计、缺失计数的调用次数、未计价次数及各币种估算费用；具体结构见 `specs/005-model-management/contracts.md`。

独立 SQLite 账本按主服务指定的会话/轮次及 runtime 稳定 `request_id` 幂等记录每个实际发出的模型请求，包括工具后续生成、历史整理及显式连接测试。`model.request.started` 记录 pending，`turn.usage` 只允许一次 succeeded/failed/cancelled 终态；主服务在 worker 中断时完成遗留请求。启动时先回填历史终态，再将仍 pending 的记录标为 failed、`failure_reason=service_interrupted`，不猜测缺失 token。统计包括各状态计数和未知状态的旧记录；本地校验及预算拒绝不计请求。未知用量不冒充零，失败或取消前已报告的消耗保留。

每轮开始冻结连接和单价；账本保留输入/输出原单价、分项费用、已知合计及 complete/partial/unpriced/legacy 计价状态。只有一侧可计价时合计为已知部分，部分计价与完全未计价分别统计；已有终态不可因重放或改价而重新计算。旧事件按原事件序号去重，保留既有金额，不补造原单价或成功状态。`GET /api/v1/assistant/usage/details?days=30&timezone=Asia/Shanghai&limit=100` 仅管理员可读，limit 为 1–100，返回最近优先的 `{records,limit,has_more,from,to,timezone}`。该估算未实现供应商缓存折扣、阶梯价格等，不等同实际账单。启动时全量回填仍保留的旧会话，不受 200 条列表限制；账本独立于会话事件裁剪。所有统计及明细不包含密钥、提示词或生成正文。

四种协议通过实际原生 SDK 执行文本流、工具调用、摘要和取消。Responses 使用 `store:false`；供应商原始 usage 按协议解释，缺少字段保持未知。多轮延续仅持久化白名单内的签名、item ID 和加密推理内容，隐藏推理明文不保存；私有 worker 检查点校验大小和字段，服务端会话回读删除这些元数据后才返回浏览器。元数据计入上下文预算，不能静默丢弃超限状态。

### 告警共享能力与助手变更提案（2026-10-18）

规则和静默由 `AlertCapabilities` 统一提供查询、异步准备校验及同步提交能力；现有规则保存、临时静默、静默创建/结束 HTTP 接口委托同一业务层，保留状态、响应与通知队列副作用。新增 `GET /api/v1/alerts/rules/:id`、`GET /api/v1/alerts/silences/:id` 和 `PUT /api/v1/alerts/silences/:id`。修改规则保留 revision 检查，修改静默要求 version，或明确匹配的整数 revision；静默版本包含对象指纹，旧记录也能检测并发冲突。修改静默要求当前范围权限；原创建者即使已离组仍可结束自己的窗口。

AI 通过 `list_alert_rules/get_alert_rule`、`list_alert_silences/get_alert_silence`、不含联系方式的 `list_alert_groups` 读取真实配置；`propose_alert_change` 只创建修改规则、规则临时静默及创建/修改/结束静默窗口的待确认提案。列表分页默认 30、最多 100，单项工具限 32 KiB，提案限 48 KiB，完整审批内容不能静默裁剪。模型不持有应用工具。

`GET /api/v1/assistant/alert-proposals/:id` 回读当前用户的完整提案；用户审阅前后配置、SQL、理由及影响后，独立点击确认才调用 `POST /api/v1/assistant/alert-proposals/:id/apply`，body 为 `{}`。提案绑定用户/会话，有效期 15 分钟；主服务在确认时重新检查权限、对象版本与有效期，在同一事务中保存业务变更、最终回读、完成状态及加密审计回执。重复确认返回原结果，回执写入失败则整体回滚。他人提案返回 404，配置冲突或过期返回 409。结束静默采用确认时的服务器时间，页面展示实际回执。

后续轮次刷新持久化提案状态，并向模型单独提供当前会话最近 20 条可信状态；更早提案可用只读 `get_alert_proposal` 核验。已完成回执只证明当次执行成功，当前配置仍需重新查询。详情与验收见 [SDD 009](../specs/009-assistant-alert-controls/contracts.md)。Agent 独立运行、systemd 安装、持久身份/队列与后续升级设计见 [部署指南](agent-deployment.md) 和 [SDD 010](../specs/010-agent-deployment/spec.md)；本次只交付部署设计，未执行部署。


## 通用record与固定窗口（2026-10-20整合）

业务初始化service/env，record(table,metric_name,dimensions,value,count)五参数必填；value是count个样本总和。固定身份、key1…key16维度及统计/分布字段遵循[SDD 010](../specs/010-telemetry-table-model/contracts/runtime.md)。每表从10/30/60/300/600/1800/3600秒中选择一个周期，默认30秒；UTC固定边界、配置历史、查询整数倍与公倍数校验遵循[SDD 011](../specs/011-aligned-metric-windows/contracts/runtime.md)。数据管理增加管理员聚合周期入口；本次整合取舍见[main整合说明](../specs/011-aligned-metric-windows/main-integration.md)。
