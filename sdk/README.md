# LightMoni SDK

所有原生 SDK 支持指标、日志和链路，支持直连 LightMoni 平台和通过 LightMoni Agent 两种独立的上报路径。直连不需要安装或启动 Agent，普通服务器、容器和 Serverless 均可使用。配置业务 service、逻辑 table；凭据必须允许该 table。当前发布 TypeScript/JavaScript、Python、Ruby，分别提供 `createLightMoniFromEnv`、`Client.from_env`、`LightMoni.from_env` 环境构造入口。PHP SDK 已下线；Go/Rust 仅保留源码，后续支持，不提供当前发布包或接入页安装入口，未纳本次发布验收。`LIGHTMONI_KEY` 仅作为旧配置兼容别名。

## 选择上报方式

“数据接入 → SDK 接入”默认展示“直连平台”，也可选择“通过 LightMoni Agent”，生成所选语言的代码与环境变量。两个选项各自保留输入地址，切换语言不改变路径。统一环境变量为 `LIGHTMONI_MODE=agent|direct|auto`、`LIGHTMONI_AGENT_ENDPOINT`、`LIGHTMONI_LOCAL_TOKEN`、`LIGHTMONI_ENDPOINT` 和 `LIGHTMONI_DATA_KEY`；两类秘密均支持对应的 `_FILE` 文件注入。显式 direct 只读取 data key，显式 agent 只读取 local token，未选路径的残留秘密不影响初始化；所选来源冲突仍会报错。auto 为已有兼容配置，本轮不改变其行为。

管理员在“管理后台 → 接入凭据”统一管理 SDK 上报密钥、Agent 接入令牌和节点 control/data 凭据；三类凭据用途不同，不能互换。SDK 直连使用的上报密钥在“SDK 上报密钥”创建并配置逻辑表权限，明文仅在创建时显示。节点的一次性 enrollment token 从“数据接入 → 执行节点接入”生成，通过安装脚本 stdin 接收，或将秘密文件的 FD 重定向到 stdin；业务 SDK 不需要节点的接入令牌或 control/data 凭据。SDK 到 Agent 的 local token 由目标 Agent 的 `local_token` 配置管理，平台不签发或回显。

| 方式 | endpoint | key | 缓存 |
| --- | --- | --- | --- |
| 直连平台（direct） | 业务进程可访问的平台基础地址 | 平台 data key，允许目标逻辑 table | SDK 进程内缓冲与重试 |
| 通过 LightMoni Agent（agent） | Agent 接收地址，默认 `http://127.0.0.1:4318` | Agent 开启本地鉴权时使用 local token | SDK 进程内缓冲，Agent 持久化磁盘队列 |

直连示例的环境配置：

~~~sh
export LIGHTMONI_MODE=direct
export LIGHTMONI_ENDPOINT='https://monitor.example.com'
export LIGHTMONI_DATA_KEY='替换为允许 business 表的 data key'
~~~

容器中通过 environment / Secret 配置上述变量。容器的 `localhost` 指向容器本身；与平台位于同一个 Docker 网络时，可用 Compose 服务地址 `http://lightmoni:8080`；Docker Desktop 访问宿主机上的平台可用 `http://host.docker.internal:端口`。实际填写平台可达的域名或服务地址，SDK 自动追加 `/v1/metrics`、`/v1/logs`、`/v1/traces`，无需 Agent 中转。

通过 Agent 的环境配置：

~~~sh
export LIGHTMONI_MODE=agent
export LIGHTMONI_AGENT_ENDPOINT='http://127.0.0.1:4318'
# 仅在 Agent 已启用本地鉴权时设置；也可使用 LIGHTMONI_LOCAL_TOKEN_FILE。
# export LIGHTMONI_LOCAL_TOKEN='替换为 Agent 的 local token'
~~~

两种显式模式失败时都在原路径重试，不会因对方可用就自动改投。复制接入页生成的环境块会清理旧模式及遗留的 `_FILE` / legacy 变量；实际凭据应通过部署环境或 Secret 注入。容器连接宿主 Agent 同样需要可达的地址，`127.0.0.1` 仅适用于同网络命名空间。

通过 Agent 时，平台凭据保存在 LightMoni Agent，业务无需持有节点的 enrollment、control 或 data credential。新 Agent 通过 enrollment 激活后，使用绑定节点的 data 凭据上报，当前允许合法业务逻辑表；旧版 Agent 的 `config.key` 仍使用 SDK 上报密钥，必须授权业务 SDK 及 `withTable` / `with_table` 子客户端涉及的 table。不同服务可共享同一个节点。SDK 缓冲不写磁盘；需要本地磁盘缓冲时选择通过 Agent 上报。Agent ACK 表示本地持久队列已接受，平台入库发生在后续转发成功后；队列有容量与最大重放期限，不承诺零丢失，也没有跨 SDK 合批或压缩。

Agent 独立提供主机采集、目录日志和拨测，业务 SDK 可以同时采用 direct。节点助手是否在线、将来是否提供 AI 诊断工具，不决定 SDK 的路由。两路径的规格、契约与验证记录见 [SDD 012](../specs/012-sdk-reporting-choice/spec.md)。

| 语言 | 运行环境 | 文档 | 发布状态 |
| --- | --- | --- | --- |
| Go | Go 1.26+ | [源码说明](go/README.md) | 后续支持；仅源码，未纳本次发布验收 |
| JavaScript / TypeScript / 浏览器 | Node 20+ / 现代浏览器 | [TypeScript](typescript/README.md) | 当前发布 |
| Python | Python 3.9+，标准库 | [Python](python/README.md) | 当前发布 |
| Ruby | Ruby 2.7+，标准库 | [Ruby](ruby/README.md) | 当前发布 |
| Rust | Rust 1.85+；reqwest、serde_json、uuid、httpdate | [源码说明](rust/README.md) | 后续支持；仅源码，未纳本次发布验收 |

这里的“封装”是 LightMoni 的原生 OTLP 客户端，不是对各语言官方 OpenTelemetry SDK 的再导出。使用标准数据模型、OTLP 编码和 W3C traceparent；指标由各语言内的有界聚合器生成。官方 OpenTelemetry 的普通 exporter 也能上报，但没有稳定批次 ID 的路径只提供至少一次交付。协议依据：[OTLP](https://opentelemetry.io/docs/specs/otlp/)。

原生 API 覆盖非负 Int64 Counter（monotonic Delta）、最后观测 Gauge、显式边界 Histogram、结构化属性日志、基础 span、请求/任务作用域、显式父上下文及 W3C header。作用域内日志自动关联 trace；Go / Node 提供 HTTP 入口与出站传播接口，其他语言通过作用域和 header 接口接入框架。没有全套框架自动埋点、C/C++、Swift、Dart/Flutter 专用封装。

## 日志 trace 字段预留

日志始终支持独立的可选 `trace_id` / `span_id`，业务代码可以只传级别、正文和属性。沿用现有接口，不要求先创建 span；没有有效 trace 上下文时，日志正常记录和上报。字段约定如下：

| 位置 | trace 字段 | 无上下文时 |
| --- | --- | --- |
| OTLP LogRecord | `traceId`、`spanId`、`flags`（Go Protobuf 为对应原生字段） | JSON 可省略，Protobuf 为默认空值 |
| 日志存储与查询 | `trace_id String`、`span_id String` | 固定列保留，值为空字符串 |
| 业务正文与 attributes | 业务自定义内容 | 不承担 trace 关联；同名属性不自动提升为 trace 字段 |

trace 元数据在调用日志 API 时从上下文复制，与记录一起冻结。批量发送、Agent 转发和失败重试沿用原值，不能在发送时读取另一请求的上下文，也不能为每条无上下文日志生成随机 trace。trace 的 sampled 标记不决定日志是否可关联，日志保留仍遵循其自身上报规则。trace ID 不默认加入指标维度。

| SDK | 当前可选上下文入口 |
| --- | --- |
| Go（后续支持，源码参考） | `TraceHandler` 绑定请求 context；`Logger(ctx).Log(...)` 绑定一次后无需逐条传 context；`Config.TraceContextProvider` 可桥接外部上下文 |
| Node.js | `withSpan(name, action)` / `withTrace(context, action)` 使用 AsyncLocalStorage；作用域内普通 `log(...)` 自动关联；`contextProvider` 可桥接外部上下文 |
| 浏览器 | `withSpan` 回调收到绑定客户端，使用该客户端记录日志；`withTrace(context)` 返回不可变绑定客户端；跨 await 不共享全局上下文 |
| Python | `with start_span(...)` 与 `with_trace(context)` 使用 contextvars；普通 `log(...)` 自动关联 |
| Ruby | `with_span` / `LightMoni.with_trace` 使用 Fiber 局部作用域；普通 `log(...)` 自动关联 |
| Rust（后续支持，源码参考） | 同步 `with_span` 回调收到绑定客户端，或 `with_trace(&context)` 创建不可变绑定客户端；`log(..., None)` 自动读取绑定；异步任务持有 span 与绑定客户端直到完成 |

### 自动关联与跨服务传播

显式传入的上下文优先。子 span 默认继承当前 trace，生成新的 span ID；正常结束或异常退出后恢复外层作用域。无作用域的普通日志继续不带 trace，只有请求/任务入口创建根 span。`WithTable` / `withTable` 子客户端保留关联与根生命周期。Ruby 新 Fiber 需要在调度时捕获当前上下文并在新执行入口激活；Rust/浏览器将绑定客户端传入异步任务。SDK 不用进程全局的“最后一个 trace”关联日志。

跨服务使用 W3C `traceparent`（`00-<32位trace_id>-<16位当前span_id>-<2位flags>`）和可选 `tracestate`：

1. 发送业务 HTTP 请求或消息时，从当前作用域导出 header；保留业务原有 header。Go 使用 `http.Client{Transport: moni.TraceTransport{}}` 和带 `r.Context()` 的请求；Node/浏览器使用 SDK 的 `client.fetch`。
2. 下游提取 header，作为请求/消费 span 的 parent：沿用同一 trace ID，生成自己的 span ID，并保留 flags / tracestate。Go 的 `TraceHandler`、Node 的 `traceHandler` 自动处理 HTTP 入口；没有或非法 traceparent 时在入口创建一次新 trace。
3. 其余语言可用已有 `extract` / `inject` 及当前上下文导出入口：Python `TraceContext.inject_current()`，Ruby `LightMoni.trace_headers`，Rust `client.trace_headers()`。消费入口用提取结果创建作用域，不需逐条修改日志代码。
4. 服务 A → B → C 的日志保持同一 `trace_id`，各服务的 span 指向上游发送时的 span。已有 OpenTelemetry 可通过 Go / Node provider 或各语言作用域桥接；Key、service、table 与 trace 身份独立。Agent/中心保留日志 payload 的关联字段，上报请求本身不替代业务上下文。

代理需转发这两个 header；浏览器跨域业务接口需在 CORS 中允许 `traceparent` / `tracestate`。消息中间件可将同一组字符串写入消息 metadata，再在消费者恢复；具体消息框架、第三方日志 appender 和完整 HTTP client span 埋点尚未提供。Go `TraceTransport`、SDK `fetch` 当前负责传播已有作用域，不自动记录额外的 HTTP client span。

当前验证入口：`npm --prefix sdk/typescript test` 包含并发请求/浏览器任务、异常恢复与双服务 HTTP；`python3 scripts/test-sdks.py` 验证当前发布的 Python/Ruby 原生实现。Go → Node → Go 多跳历史检查保留在源码和证据中，Go/Rust 后续支持须另行验收。

## 生命周期与边界

TypeScript 保留周期 collection 和后台 exporter。Python/Ruby 的记录 API 只修改内存，提供显式 flush；默认自监控启用时，后台线程每 30 秒同时 Flush 当前业务窗口。关闭自监控后由应用调度 flush。Python 的配置轮询是独立线程，不受自监控或停报开关影响。发送期间不持有记录锁。Go/Rust 生命周期说明保留在各自源码文档中，未纳本次发布验收。

flush 冻结当前窗口，等待调用边界内所有批次得到 ACK，后续记录属于下一窗口。网络失败、429/502/503/504 使用有抖动的指数退避，尊重 Retry-After；401/403 保留队列等待修复 Key。超时保留未确认批次，下次 flush 使用相同 UUID、创建时间和正文。updateKey / update_key 不改冻结正文，正在进行的退避不会主动唤醒。

永久拒绝和 OTLP partialSuccess 不重发整批；拒绝数在 stats 可见，使此实例后续 flush 持续报告数据损失。活跃缓冲默认 8 MiB，待发送队列 8 MiB / 256 批，单批 1 MiB，每 instrument 每窗口 2000 个真实维度组合加一个 overflow 点，共 256 instruments。属性最多 32 个、编码后 4096 字节，键最多 128 字节，日志正文最多 64 KiB。容量满拒绝新数据，不覆盖待确认旧批；损失持续报告。

按完整、有类型的属性元组聚合，整数与字符串不混合，记录时复制属性。维度超限生成 otel.metric.overflow=true；Gauge overflow 是 overflow 来源最后观测。同 table 同名指标类型/单位/边界冲突会报错。stats 包含队列字节/批次、活跃缓冲、交付、重试、无效输入、overflow、丢弃、拒绝及最近错误。

SDK 不写磁盘；Agent SQLite 提交 ACK 后才释放 SDK 批次。ACK 前进程崩溃可能丢内存数据；服务端去重由既有采集链路保证。退出时先停止业务生产，再带截止时间 shutdown；失败报告错误并关闭实例。新进程/客户端生成独立的 service.instance.id。

## 验收

~~~sh
python3 scripts/test-sdks.py
# 本机缺少 Python/Ruby 时可使用隔离容器：
python3 scripts/test-sdks.py --docker
npm --prefix sdk/typescript test
~~~

共享 HTTP 测试检查聚合、Int64 精度、Gauge 不补零、Histogram 桶、W3C 父上下文、日志/span 关联、跨 table、overflow、503/429/401/损坏 ACK/连接断开丢 ACK、冻结重试与下一窗口、永久拒绝、partialSuccess 和容量损失。真实 Agent 和隔离 ClickHouse 验收见 [验收证据](../docs/evidence/multilang-sdk/README.md)。`scripts/sdk-smoke.py --mode direct` 验证当前发布的 TypeScript/JavaScript、Python、Ruby 直连中心；容器可用 `--container-endpoint` 和 `--docker-network` 指定中心地址与网络。

## 内部监控

SDK 默认每 30 秒报告一次实例心跳、待发送批次/字节和累计重试、丢弃、拒绝、无效输入、维度溢出等诊断；启动及诊断变化会生成内部日志。原始心跳时间随冻结批次保留，断网补传不会把过期实例算作在线。中心按最近 90 秒的心跳统计在线 SDK 实例。

自监控批次仍使用根客户端的业务 table 和 Key 经 Agent 或直连上报；中心验证业务 table 权限后，将识别出的 SDK 内部记录自动归入 `metric_lightmoni_sdk_gauge` / `log_lightmoni_sdk`，并保留 `source_table`、service、instance_id、agent_id、key_id。无需给 Key 添加系统表写入权限。WithTable 子客户端共享一次心跳生命周期。

内部快照排在业务批次之后，受同一队列容量限制；满队列时跳过自监控快照，下一周期重试。内部诊断只记录固定事件和计数，不复制网络请求、Key 或任意异常文本，也不会从上报失败处理器递归写入队列。后台发送是尽力上报；应用退出前仍需调用有截止时间的 Shutdown。

Node.js 有独立的心跳定时器；Python/Ruby 的后台工作线程每 30 秒调用一次有 5 秒截止时间的 Flush，连同当前业务窗口一起发送。Python/Ruby fork 后请重新初始化 SDK。

可关闭自监控：TypeScript `selfTelemetry:false`；Python/Ruby `self_telemetry=false`。Agent 与中心的嵌入 SDK 会关闭此功能并使用各自的系统监控通道。

## SDK 停报与日志上报规则

当前发布的 JavaScript/TypeScript（Node 和浏览器）、Python 支持以下动态配置；Ruby 尚未接入这一规则协议。Go 源码保留对应实现但未纳本次发布验收，Rust 为后续支持。

- **SDK 整体停报**：在“数据接入 → SDK 接入 → SDK 停报规则”按 service、instance_id、sdk.language 或 resource:资源属性选择实例。命中任一规则后停止该根 SDK 与所有 WithTable 子客户端的日志、指标、链路和自监控，清空未发送数据。配置拉取继续运行，删除规则后自动恢复，不补传停报期间的数据。已经得到 Agent 持久化 ACK 或已经在网络上提交的数据不能撤回。
- **部分 UID 日志不上报**：在“数据管理 → 业务日志表 → 上报规则”的排除规则中配置 attr:user_id 等实际字段。命中任一排除规则即忽略日志，优先于 QA、VIP 和普通上报规则。metric 和 trace 不受日志排除或降采样影响。
- **命中才上报**：每条上报规则有条件和保留比例；同一规则内条件全部命中，多条规则之间任意命中即可，重叠时取最高保留比例。QA / VIP 可设 100%，普通点击可设 10%。未命中任何规则的业务日志不入队。conditions=[] 显式匹配全部日志；rules=[] 显式忽略全部业务日志。未配置策略的表保持全量。错误日志需要配置 severity=ERROR/FATAL 的上报规则，没有隐式兜底。

条件支持 in（类型严格的等于任一值）与 exists；字段支持 attr:属性、resource:资源属性、service、severity、trace_id、instance_id、sdk.language。字符串 "true" 与布尔 true 不相等；长 UID 建议作为字符串传输。key 可设置 attr:user_id / attr:session_id，按用户或会话稳定选取；字段缺失或空字符串时按单条事件选取。用户/会话采样不是事件数的严格配额；保留比例描述选取概率。

保留的日志增加 lightmoni.sampling.rate、lightmoni.sampling.weight 和 lightmoni.sampling.rule 属性。日志查询的原始 count 仍是实际保留数量；weight 可用于估算总体数量，但不能保证还原完整用户、漏斗或会话。明确被规则忽略的日志不会计入 dropped_records，不会令 Flush 报数据损失。

中心只存储和下发规则，不再次过滤或采样入库数据。直连 SDK 的 `GET /v1/sdk-config` 使用上报 Key，日志策略只包含该 Key 允许的逻辑表。Agent 同路径转发配置，本地请求按 Agent 的 local token 配置鉴权；新 Agent 向中心使用 control 凭据拉取配置，旧版 Agent 兼容中心上报 Key，中心暂时不可达时可返回已验证的磁盘缓存。浏览器业务后端同时转发配置与 OTLP，演示见 examples/sdk/browser/server.mjs。

HTTP SDK 默认每 30 秒拉取一次，配置经过完整验证后原子替换；失败或非法配置保留上一份有效策略。SDK 刚启动、首次配置尚未到达时沿用本地配置（未配置则全量），需要从第一条日志就执行远程 UID 排除/停报规则时，务必在业务生产前显式等待 RefreshConfig / refreshConfig 成功。自定义 Exporter 可另设配置地址。配置变更只影响后续 Log；已缓冲/冻结的日志与重试正文不重筛。整体停报是单独的强开关，会取消正在发送的请求并清空 SDK 的缓冲与队列。

Go 源码的配置参考见 [Go SDK（后续支持）](go/README.md)。TypeScript 支持 options.logSampling、disabled、configEndpoint、configIntervalMs（默认 30000）、remoteConfig:false；运行中可调用 updateLogSampling、setReportingEnabled、await refreshConfig()。远程表策略优先于本地表策略；本地 disabled 开关与远程停报规则同时生效。

Python 支持 Client 的 log_sampling、disabled、remote_config、config_endpoint、config_key、config_interval（秒，默认 30，最小 1），以及 resource / instance_id 选择器输入；运行中可调用 update_log_sampling、set_reporting_enabled、refresh_config(timeout=5)。配置请求禁止重定向，最大 1 MiB，采用最多五秒超时预算（阻塞的系统 DNS 解析可能超出预算）；失败保留旧配置，stats 展示 config_revision/config_error 和 excluded_logs/unmatched_logs/sampled_out_logs/disabled_records/reporting_disabled。远程表规则优先，本地停报不能被远程恢复覆盖。停报前或期间创建的 Span 不会在恢复后补交；已在网络中提交的数据无法撤回。Python 的完整示例与生命周期见 [Python SDK](python/README.md)。

~~~typescript
const mon = createLightMoni({service:'web-api', table:'web', endpoint, key,
  logSampling: {web: {key:'attr:user_id',
    exclude:[{name:'排除 UID',conditions:[{field:'attr:user_id',operator:'in',values:['blocked-1']}]}],
    rules:[
      {name:'QA',rate:1,conditions:[{field:'attr:user_id',operator:'in',values:['qa-1','qa-2']}]},
      {name:'VIP',rate:1,conditions:[{field:'attr:is_vip',operator:'in',values:[true]}]},
      {name:'错误',rate:1,conditions:[{field:'severity',operator:'in',values:['ERROR','FATAL']}]},
      {name:'点击',rate:0.1,conditions:[{field:'attr:event',operator:'in',values:['click']}]},
    ]}}});
await mon.refreshConfig(); // 在启动业务生产之前取得配置；失败时由业务决定是否启动。
mon.log('info','checkout clicked',{user_id:'qa-1',event:'click'});
~~~

后台配置接口：GET/PUT `/api/v1/settings/sdk-reporting`（disable_rules），GET/PUT `/api/v1/catalog/tables/{id}/log-sampling`（key/rules/exclude）。保存仅管理员可用；系统日志表与 metric/trace 表禁止配置日志采样。每表最多 32 条上报和 32 条排除规则，每规则最多 8 个条件，每 in 最多 256 个标量值。非零保留比例最低 0.000001。

当前验证入口：`npm --prefix sdk/typescript test`。真实 UI/SQLite/ClickHouse/Node/浏览器回归见 `node examples/sdk/reporting.mjs`（对隔离测试实例运行），证据见 [SDK 上报规则验收](../docs/evidence/sdk-reporting/README.md)。

Python 新增规则、取消和配置回退验证：`PYTHONPATH=sdk/python python3 -m unittest discover -s sdk/python/tests -v`；中心/Agent 隔离集成与证据见 [SDD 004](../specs/004-python-sdk-reporting/verification.md)。
