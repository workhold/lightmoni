# LightMoni SDK

所有原生 SDK 支持指标、日志和链路，可通过 Agent 上报，也可带 Key 直连中心，容器和没有 Agent 的服务同样可以接入。配置业务 service、逻辑 table；Key 必须允许该 table。withTable / with_table 共享根客户端生命周期。

## 选择上报方式

“数据接入 → SDK 接入”可切换“通过 Agent”和“直连中心”，生成所选语言的代码与环境变量。示例读取 `LIGHTMONI_ENDPOINT`、`LIGHTMONI_KEY` 并传入 SDK；SDK 本身不自动读取这两个变量。

| 方式 | endpoint | key | 缓存 |
| --- | --- | --- | --- |
| 通过 Agent | Agent 地址，默认 `http://127.0.0.1:4318` | 通常留空；Agent 开启本地令牌时传该令牌 | SDK 进程内缓冲，Agent 持久化磁盘队列 |
| 直连中心 | 业务进程可访问的中心基础地址 | 中心上报 Key，允许目标逻辑 table | SDK 进程内缓冲与重试 |

直连示例的环境配置：

~~~sh
export LIGHTMONI_ENDPOINT='https://monitor.example.com'
export LIGHTMONI_KEY='替换为允许 business 表的上报 Key'
~~~

容器中通过 environment / Secret 配置这两个变量。容器的 `localhost` 指向容器本身；与中心位于同一个 Docker 网络时，可用 Compose 服务地址 `http://lightmoni:8080`；Docker Desktop 访问宿主机上的中心可用 `http://host.docker.internal:端口`。实际填写中心可达的域名或服务地址，SDK 自动追加 `/v1/metrics`、`/v1/logs`、`/v1/traces`，无需 Agent 中转。

通过 Agent 时，中心 Key 保存在 Agent，且必须允许业务 SDK 的 table。不同服务可共享同一个 Agent；使用 `withTable` / `with_table` 切换表时，中心 Key 也需授权对应 table。SDK 缓冲不写磁盘；需要本地磁盘缓存时选择 Agent。

| 语言 | 运行环境 | 安装与示例 |
| --- | --- | --- |
| Go | Go 1.26+ | [Go](go/README.md) |
| JavaScript / TypeScript / 浏览器 | Node 20+ / 现代浏览器 | [TypeScript](typescript/README.md) |
| Python | Python 3.9+，标准库 | [Python](python/README.md) |
| Java / Kotlin（JVM） | JDK 17+，Gson 2.11.0 | [Java](java/README.md) |
| C# / .NET | .NET 8+，系统库 | [.NET](dotnet/README.md) |
| PHP | 64 位 PHP 8.1+、JSON、HTTP/HTTPS stream wrapper | [PHP](php/README.md) |
| Ruby | Ruby 2.7+，标准库 | [Ruby](ruby/README.md) |
| Rust | Rust 1.85+；reqwest、serde_json、uuid、httpdate | [Rust](rust/README.md) |

这里的“封装”是 LightMoni 的原生 OTLP 客户端，不是对各语言官方 OpenTelemetry SDK 的再导出。使用标准数据模型、OTLP 编码和 W3C traceparent；指标由各语言内的有界聚合器生成。官方 OpenTelemetry 的普通 exporter 也能上报，但没有稳定批次 ID 的路径只提供至少一次交付。协议依据：[OTLP](https://opentelemetry.io/docs/specs/otlp/)。

原生 API 覆盖非负 Int64 Counter（monotonic Delta）、最后观测 Gauge、显式边界 Histogram、结构化属性日志、基础 span、显式父上下文及 W3C header。Python 另提供 contextvars 和 span context manager；其余新语言显式传递 span context。Java SDK 可在 Kotlin/JVM 中使用，不包括 Android/Kotlin Multiplatform。没有自动框架埋点、C/C++、Swift、Dart/Flutter 专用封装。

## 生命周期与边界

Go / TypeScript 保留现有周期 collection 和后台 exporter。六个新 SDK 使用**显式 flush**：记录 API 只修改内存，在应用自己的定时任务、请求结束或退出时调用 flush（.NET 为 FlushAsync），不自动创建后台线程。PHP 限单请求/单 worker，不能跨线程共享。其他语言发送期间不持有记录锁；Rust 的 blocking exporter 应放在异步 runtime 的 blocking worker。

flush 冻结当前窗口，等待调用边界内所有批次得到 ACK，后续记录属于下一窗口。网络失败、429/502/503/504 使用有抖动的指数退避，尊重 Retry-After；401/403 保留队列等待修复 Key。超时保留未确认批次，下次 flush 使用相同 UUID、创建时间和正文。updateKey / update_key 不改冻结正文，正在进行的退避不会主动唤醒。

永久拒绝和 OTLP partialSuccess 不重发整批；拒绝数在 stats 可见，使此实例后续 flush 持续报告数据损失。活跃缓冲默认 8 MiB，待发送队列 8 MiB / 256 批，单批 1 MiB，每 instrument 每窗口 2000 个真实维度组合加一个 overflow 点，共 256 instruments。属性最多 32 个、编码后 4096 字节，键最多 128 字节，日志正文最多 64 KiB。容量满拒绝新数据，不覆盖待确认旧批；损失持续报告。

按完整、有类型的属性元组聚合，整数与字符串不混合，记录时复制属性。维度超限生成 otel.metric.overflow=true；Gauge overflow 是 overflow 来源最后观测。同 table 同名指标类型/单位/边界冲突会报错。stats 包含队列字节/批次、活跃缓冲、交付、重试、无效输入、overflow、丢弃、拒绝及最近错误。

SDK 不写磁盘；Agent SQLite 提交 ACK 后才释放 SDK 批次。ACK 前进程崩溃可能丢内存数据；服务端去重由既有采集链路保证。退出时先停止业务生产，再带截止时间 shutdown；失败报告错误并关闭实例。新进程/客户端生成独立的 service.instance.id。

## 验收

~~~sh
python3 scripts/test-sdks.py
# 本机缺运行时时用隔离容器运行 Java/.NET/PHP/Rust：
python3 scripts/test-sdks.py --docker
go test -race ./sdk/go
npm --prefix sdk/typescript test
~~~

共享 HTTP 测试检查聚合、Int64 精度、Gauge 不补零、Histogram 桶、W3C 父上下文、日志/span 关联、跨 table、overflow、503/429/401/损坏 ACK/连接断开丢 ACK、冻结重试与下一窗口、永久拒绝、partialSuccess 和容量损失。真实 Agent 和隔离 ClickHouse 验收见 [验收证据](../docs/evidence/multilang-sdk/README.md)。`scripts/sdk-smoke.py --mode direct` 验证八种 SDK 直连中心；容器可用 `--container-endpoint` 和 `--docker-network` 指定中心地址与网络。

## 内部监控

SDK 默认每 30 秒报告一次实例心跳、待发送批次/字节和累计重试、丢弃、拒绝、无效输入、维度溢出等诊断；启动及诊断变化会生成内部日志。原始心跳时间随冻结批次保留，断网补传不会把过期实例算作在线。中心按最近 90 秒的心跳统计在线 SDK 实例。

自监控批次仍使用根客户端的业务 table 和 Key 经 Agent 或直连上报；中心验证业务 table 权限后，将识别出的 SDK 内部记录自动归入 `metric_lightmoni_sdk_gauge` / `log_lightmoni_sdk`，并保留 `source_table`、service、instance_id、agent_id、key_id。无需给 Key 添加系统表写入权限。WithTable 子客户端共享一次心跳生命周期。

内部快照排在业务批次之后，受同一队列容量限制；满队列时跳过自监控快照，下一周期重试。内部诊断只记录固定事件和计数，不复制网络请求、Key 或任意异常文本，也不会从上报失败处理器递归写入队列。后台发送是尽力上报；应用退出前仍需调用有截止时间的 Shutdown。

Go / Node.js 有独立的心跳定时器；Python / Java / .NET / Ruby / Rust 的后台工作线程每 30 秒调用一次有 5 秒截止时间的 Flush，连同当前业务窗口一起发送。PHP 使用请求生命周期：在请求结束调用 Flush/Shutdown，长驻 worker 每 30 秒调用 Flush；不创建后台线程。Python / Ruby fork 后请重新初始化 SDK。

可关闭自监控：Go `Config.DisableSelfTelemetry=true`；TypeScript `selfTelemetry:false`；Python / Ruby `self_telemetry=false`；Java `Limits.selfTelemetry=false`；.NET `new Limits(SelfTelemetry:false)`；PHP 限制数组 `['self_telemetry'=>false]`；Rust `Limits { self_telemetry:false, ..Limits::default() }`。Agent 与中心的嵌入 SDK 会关闭此功能并使用各自的系统监控通道。

## SDK 停报与日志上报规则

Go、JavaScript / TypeScript（Node 和浏览器）支持以下动态配置。Python、Java、.NET、PHP、Ruby、Rust 当前仍按既有方式全量记录，尚未接入这一规则协议。

- **SDK 整体停报**：在“数据接入 → SDK 接入 → SDK 停报规则”按 service、instance_id、sdk.language 或 resource:资源属性选择实例。命中任一规则后停止该根 SDK 与所有 WithTable 子客户端的日志、指标、链路和自监控，清空未发送数据。配置拉取继续运行，删除规则后自动恢复，不补传停报期间的数据。已经得到 Agent 持久化 ACK 或已经在网络上提交的数据不能撤回。
- **部分 UID 日志不上报**：在“数据接入 → 数据表 → 业务日志表 → 上报规则”的排除规则中配置 attr:user_id 等实际字段。命中任一排除规则即忽略日志，优先于 QA、VIP 和普通上报规则。metric 和 trace 不受日志排除或降采样影响。
- **命中才上报**：每条上报规则有条件和保留比例；同一规则内条件全部命中，多条规则之间任意命中即可，重叠时取最高保留比例。QA / VIP 可设 100%，普通点击可设 10%。未命中任何规则的业务日志不入队。conditions=[] 显式匹配全部日志；rules=[] 显式忽略全部业务日志。未配置策略的表保持全量。错误日志需要配置 severity=ERROR/FATAL 的上报规则，没有隐式兜底。

条件支持 in（类型严格的等于任一值）与 exists；字段支持 attr:属性、resource:资源属性、service、severity、trace_id、instance_id、sdk.language。字符串 "true" 与布尔 true 不相等；长 UID 建议作为字符串传输。key 可设置 attr:user_id / attr:session_id，按用户或会话稳定选取；字段缺失或空字符串时按单条事件选取。用户/会话采样不是事件数的严格配额；保留比例描述选取概率。

保留的日志增加 lightmoni.sampling.rate、lightmoni.sampling.weight 和 lightmoni.sampling.rule 属性。日志查询的原始 count 仍是实际保留数量；weight 可用于估算总体数量，但不能保证还原完整用户、漏斗或会话。明确被规则忽略的日志不会计入 dropped_records，不会令 Flush 报数据损失。

中心只存储和下发规则，不再次过滤或采样入库数据。`GET /v1/sdk-config` 使用现有上报 Key，日志策略只包含该 Key 允许的逻辑表。Agent 同路径转发配置，使用本地令牌认证并由 Agent 保管中心 Key，中心暂时不可达时可返回已验证的磁盘缓存。浏览器业务后端同时转发配置与 OTLP，演示见 examples/sdk/browser/server.mjs。

HTTP SDK 默认每 30 秒拉取一次，配置经过完整验证后原子替换；失败或非法配置保留上一份有效策略。SDK 刚启动、首次配置尚未到达时沿用本地配置（未配置则全量），需要从第一条日志就执行远程 UID 排除/停报规则时，务必在业务生产前显式等待 RefreshConfig / refreshConfig 成功。自定义 Exporter 可另设配置地址。配置变更只影响后续 Log；已缓冲/冻结的日志与重试正文不重筛。整体停报是单独的强开关，会取消正在发送的请求并清空 SDK 的缓冲与队列。

Go 支持 Config.LogSampling、Config.Disabled、Config.ConfigEndpoint / ConfigKey、Config.ConfigInterval（默认 30 秒）、Config.DisableRemoteConfig；运行中可调用 UpdateLogSampling、SetReportingEnabled、RefreshConfig(ctx)。TypeScript 支持 options.logSampling、disabled、configEndpoint、configIntervalMs（默认 30000）、remoteConfig:false；运行中可调用 updateLogSampling、setReportingEnabled、await refreshConfig()。远程表策略优先于本地表策略；本地 disabled 开关与远程停报规则同时生效。

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

验证入口：`go test -race ./sdk/go ./internal/agent ./internal/ingest ./internal/server`、`npm --prefix sdk/typescript test`。真实 UI/SQLite/ClickHouse/Node/浏览器回归见 `node examples/sdk/reporting.mjs`（对隔离测试实例运行），证据见 [SDK 上报规则验收](../docs/evidence/sdk-reporting/README.md)。
