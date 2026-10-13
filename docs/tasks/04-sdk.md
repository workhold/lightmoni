# 04 · SDK 开发任务书

状态：服务器 SDK 首版代码已实现并完成模块验证；主干已完成 Go / Node → 主服务 → 真实 ClickHouse 联调，继续扩大故障恢复验收。以 [产品约束](../brief.md) 和 [公共契约](../contracts.md) 为准。

已交付 `sdk/go`（package `moni`）、`sdk/typescript` 的 Node / 浏览器入口，以及 `examples/sdk/go`、`examples/sdk/node`、`examples/sdk/browser`。Go 使用标准 OTLP Protobuf；TypeScript 使用标准 OTLP JSON，含十六进制 trace ID 与十进制字符串 int64。多个 Key 可配置逻辑 table 白名单或显式允许所有 table，不按 service 绑定。Go / Node 的完整维度聚合、Gauge、Histogram、冻结批次、缓存边界、Key 轮换、partial success 测试通过；Go race 与 Go / Node → 真实 Agent HTTP → SQLite spool 关闭重开恢复测试通过。主干真实 ClickHouse 联调验证每个语言 service 的 Counter 总量 20、日志 20、span 20、trace JOIN 关联及同一全局 Key 的 key_id 来源。浏览器 demo 经业务后端转发已真实验收两次点击、log_web、metric_web_sum/gauge 和持久化 ACK；页面关闭的尽力 flush 与包体积验证仍需完成；自动框架埋点尚未交付。

2026-10-11 扩展：新增 Python、Java/Kotlin JVM、C#/.NET、PHP、Ruby、Rust 原生 OTLP JSON SDK、独立源码安装包、示例、语言选择与下载入口。不是完整官方 OTel SDK 的再导出。六种语言使用显式 flush（应用调度），共享有界聚合、冻结批次、Key 修复、W3C 上下文和诊断。60 个共享协议/故障测试通过；真实 Agent SQLite 关闭重开验收通过；八种 SDK 经 Agent 到隔离 ClickHouse，每服务 Counter=20、关联日志/span=20、Histogram count=20、Gauge=3。扩展接口与边界见 [SDK 总览](../../sdk/README.md)，证据见 [多语言验收](../evidence/multilang-sdk/README.md)。C/C++、Swift、Dart/Flutter 和自动框架埋点未包含在本轮。

## 目标与范围

2026-10-13 扩展：八种 SDK 已提供请求/任务作用域或不可变绑定客户端，作用域内日志自动关联 trace；Go / Node HTTP 入口与出站、.NET 出站支持 W3C 传播。Go → Node → Go 多跳 HTTP、并发隔离、嵌套/异常恢复及原生示例已验证。完整第三方框架、消息和日志 appender 适配继续按需扩展。

让 Go、JavaScript/TypeScript、Python、Java/Kotlin JVM、C#/.NET、PHP、Ruby、Rust 业务只配置 `service`、`table`、上报地址，就能记录多维指标、结构化日志和基础 trace。默认连接本机 Agent；需要直接上报主服务时增加实例级写入 Key。一个业务进程可以使用多个 table，一台机器的多个服务不需要分别申请 Key。

实现复用 OpenTelemetry 的数据模型、OTLP 编码与 W3C 上下文协议，聚合由 LightMoni 的有界聚合器完成，未引入完整 OTel 自动埋点 SDK。LightMoni 封装初始化、table 路由、冻结批次、可靠重试和简单 API。依赖版本通过实际 build / 测试后锁定，不假定不同语言的日志、指标 API 具有相同成熟度。本轮覆盖 SDK 总览列出的服务端主流语言，不实现 PromQL、浏览器会话回放或浏览器磁盘离线队列。

交付范围：

| 部分 | 首版交付 |
| --- | --- |
| Go | 可独立使用的 SDK；Counter、Gauge、Histogram、日志、基础 span/context；可嵌入 Agent 的 exporter |
| Node.js TypeScript | 同样的业务语义、HTTP exporter、Node 请求上下文与业务样例；不依赖 Go 进程 |
| 浏览器 | 独立轻量入口，手工事件/错误/性能指标和基础 trace；直接连接公开采集入口 |
| 文档与样例 | 本机 Agent、直接上报、多个 table、自定义维度、优雅退出、故障边界、浏览器公开凭证 |

## 代码归属与协作

本 Agent 只负责 `sdk/go/`、`sdk/typescript/`、`examples/sdk/`。Go SDK 的导出接口应可供 Agent 导入，不能依赖 `internal/agent`、数据库或主服务内部包。协议类型、采集入口、表映射和幂等存储由主干维护；本模块提供所需字段和测试夹具，不另写一套服务端协议。

依赖主干提供采集协议、标准错误响应、批次限制及真实集成服务；依赖 Agent 提供本机接收入口和持久化 exporter。这两项完成前，可以用可注入的内存 exporter、HTTP 假服务器和共享 OTLP 夹具开发 SDK。不要用假服务器通过的结果代替端到端可靠性验收。

## 配置和业务 API

初始化必须验证 `service`、逻辑 `table`、endpoint。用户填写 `http`、`app` 等业务名字；SDK 不让用户手填 `metric_`、`log_` 等存储前缀。`WithTable` / `withTable` 返回一个不可变的 table 客户端，保持同一 service 与连接配置。每个 table 的 reader/export 路由独立，不能把 table 放进用户的指标标签来凑出分表效果。根客户端统一管理这些子客户端的生命周期，根客户端的 Flush/Shutdown 覆盖其创建的全部 table。

最少配置：`service`、`table`、`endpoint`。可选配置包括直接上报 Key、资源属性、导出周期、有界队列容量、批次大小、请求超时、retry 上限、指标维度上限和诊断回调。首次初始化的错误可以返回或抛出；网络故障不得使业务的计数、日志调用抛出网络异常。

拟实现的 Go 使用方式：

```go
mon, err := lightmoni.New(lightmoni.Config{
    Service:  "payment-api",
    Table:    "http",
    Endpoint: "http://127.0.0.1:4318",
})
if err != nil {
    return err
}
requests, err := mon.Meter().Counter("http.requests", lightmoni.MetricOptions{
    Unit: "{request}",
})
if err != nil {
    return err
}
ctx, span := mon.Tracer().Start(ctx, "payment.create")
defer span.End()
requests.Add(ctx, 1, lightmoni.Attributes{
    "route": "/payments", "method": "POST", "status": int64(200),
})
mon.WithTable("app").Log(ctx, "info", "payment completed",
    lightmoni.Attributes{"payment_id": "p_123"})

// 在应用退出入口使用有截止时间的 context；超时/未交付必须返回错误。
return mon.Shutdown(shutdownCtx)
```

拟实现的 Node.js 使用方式：

```typescript
const mon = createLightMoni({
  service: "payment-api",
  table: "http",
  endpoint: "http://127.0.0.1:4318",
});
const requests = mon.meter.counter("http.requests", { unit: "{request}" });
const duration = mon.meter.histogram("http.duration", {
  unit: "ms",
  boundaries: [5, 10, 25, 50, 100, 250, 500, 1000],
});
requests.add(1, { route: "/payments", method: "POST", status: 200 });
duration.record(18.2, { route: "/payments", method: "POST", status: 200 });
mon.withTable("app").log("info", "payment completed", { payment_id: "p_123" });
await mon.flush({ timeoutMs: 5000 });
await mon.shutdown({ timeoutMs: 5000 });
```

样例是可运行工程。日志预留独立的可选 `trace_id`、`span_id`，请求/任务作用域内自动注入，业务无需逐条传 ID；无有效上下文时日志正常上报，字段为空。Go `TraceHandler`、Node `traceHandler` 创建或继承 HTTP 请求 trace；Go `TraceTransport`、SDK `fetch` 和 .NET `TraceHttpHandler` 传播 W3C header。所有语言支持作用域或绑定客户端，嵌套/异常恢复与并发隔离已纳入验收；关联在日志调用时捕获并随批次冻结。用法与跨服务边界见 [SDK 日志 trace 约定](../../sdk/README.md#日志-trace-字段预留)。具体消息框架、第三方日志 appender 与完整自动埋点矩阵仍作为可选适配层扩展。

## 指标语义

以下是 LightMoni 的首版选择，语义参考 [OpenTelemetry Metrics SDK](https://opentelemetry.io/docs/specs/otel/metrics/sdk/) 中的 temporality 和 cardinality 约束，代码使用自身有界聚合器。

| 指标 | 窗口产物 | 约束 |
| --- | --- | --- |
| Counter | 每个完整维度组合在本次 collection 区间内的增量总和；OTLP monotonic Sum，Delta temporality | 不接受负增量；导出后下一窗口从新的增量开始 |
| Gauge | 本来源、同一完整维度组合的最后一次观测；保留采集产生的原始 point 时间 | 不把多个实例的值先求平均或求和；无新观测不伪造为零 |
| Histogram | 固定显式边界的 bucket counts、count、sum；Delta temporality | `len(bucket_counts) = len(boundaries) + 1`；每次观测只入一个桶；查询时合并兼容边界 |

“多个自定义维度”指完整属性元组，如 `(route, method, status)`。同一个窗口的 `POST + /payments + 200` 合并计数，`POST + /payments + 500` 单独计数。不能对每个属性分别累计后声称仍保留了这些维度的联合分布。

属性规范化必须稳定：键排序、值类型保留，`1` 与 `"1"` 不混为一个维度；拒绝无效数值及超限键值，并通过诊断反馈。采样记录后修改调用方传入的对象，不得改变已经聚合的数据。维度中禁止默认加入 `trace_id`、请求 ID 等高基数标识；这些标识放在日志、span 或可选 exemplar 中。

首版限制每个 instrument 每次 collection 的维度数量，也限制 instrument 总数、属性数及键值长度。超出维度限制的 Counter/Histogram 进入明确标记的 overflow 聚合，保留数量但失去具体维度；不能把未知组合随机归入某个真实标签。Gauge 的 overflow 只能表示 overflow 来源的最后观测，不能解释成某个真实实例的值。限制、overflow 和拒绝数量均对开发者可见。队列丢弃与维度 overflow 是两类独立诊断。

资源身份包含 `service.name`、每次进程启动唯一的 `service.instance.id`，以及 Agent 补充的主机/Agent 标识。重试保留原资源身份，进程重启生成新实例身份。用户维度相同的多个进程仍是不同来源；后端跨来源 Counter/Histogram 可以按查询合并，Gauge 必须由查询明确选择聚合方式。Histogram 边界、单位或类型不同的同名 instrument 不得静默混合；初始化冲突报错或诊断。

日志/span 保留原始事件时间；指标保留 collection 产生的 `start_time`/`end_time` 或 point 时间。Delta 的区间连续推进，不按网络重试时间重建窗口。区间按 reader 的实际 collection 时刻形成，不承诺所有进程都对齐同一墙钟边界。OTel Gauge 的 point 时间与业务最后一次调用 Record 的时间不能混为同一个保证；如需单独的观测时间字段，应由主干明确 schema 后实现。Go 需要并发安全的 record/collect/shutdown；Node Worker 或多进程各有独立实例身份，不能共享一个可变聚合器。时钟回拨和同时间 Gauge 观测的次序需要专门验证，保留内部顺序或单调时间依据，不能得到负长度窗口。

## 协议、缓存与确认边界

一次 HTTP 请求只含一个 signal、一个逻辑 table。使用标准 OTLP/HTTP 的 `/v1/metrics`、`/v1/logs`、`/v1/traces` 和 Protobuf 编码；浏览器的编码由主干公开入口能力统一。`service.name` 在 resource 中，`X-Lightmoni-Table` 为逻辑 table，`X-Lightmoni-Batch-ID` 标识一个新冻结批次。table 不写入 metric 的业务维度。

标准 exporter 可以配置 table header；逐批唯一的 batch ID 需要 LightMoni exporter/transport 生成，不能用一个静态 header 当成所有请求的批次 ID。普通第三方 OTLP exporter 没有稳定批次 ID 时，按至少一次接收，不能承诺重试不重复。所有 LightMoni SDK 路径均需使用冻结批次能力。

队列状态如下：

```text
record/collect → 冻结聚合快照并序列化 → SDK 有界待发送队列
              → exporter 投递 → Agent 持久化 ACK → 释放该冻结批次
```

冻结批次包含 signal、table、batch ID、原始资源/时间和已经序列化的 payload。此后不能重新读取 aggregator 重建这个批次。collection 接管旧窗口时，要把快照交给 SDK 队列再处理下一窗口；若 reader 已推进 Delta 但 export 失败，也必须仍持有原快照。下一窗口的新增计数与旧窗口重试不能相互覆盖，也不能把旧窗口增量重新并入当前窗口。

重试保持相同 batch ID 和 payload；压缩、签名等传输字段的变化不能改变遥测正文语义。Agent 不重新聚合 SDK 已聚合的业务 Delta。主服务的事件幂等、存储去重和 SQL 正确性由主干负责，SDK 的稳定 ID 是必要输入，不能代替服务端实现。

内存队列按字节和批次数双重限额；普通业务 record 不等待网络。内存满时采用显式、可配置的丢弃策略，首版默认拒绝新冻结批次并计数，不能无限堆积或默默覆盖尚未确认的旧批次。SDK 诊断包括待发送字节/批次、最老批次年龄、重试、overflow、无效输入、丢弃原因和最后一次错误；诊断输出不能再写回同一已满的遥测队列形成递归。

SDK 默认不写磁盘。Agent 收到批次并完成其持久化队列提交后才返回成功；SDK 此时可以释放本地冻结批次。SDK 到 Agent 之前发生进程崩溃，内存中的数据可能丢失。`Flush` 先收集当前窗口，再等待调用边界内的全部批次获得持久化 ACK；并发产生的新记录不无限延长 Flush。`Shutdown` 有截止时间，超时报告剩余批次及错误，不宣称成功落盘。直接连接主服务时，确认边界是主服务定义的持久化写入，行为保持一致。

Go SDK 暴露可注入 exporter，例如 `Deliver(ctx, FrozenBatch) error`。Agent 内置 SDK 使用这个接口直接提交自身持久化队列，返回成功的含义仍是队列提交完成。SDK 不启动 Agent、不要求网络访问 localhost，也不依赖 Agent 内部实现。Agent 对批次补充一次主机资源信息后，持久化并冻结最终转发正文，重启恢复及后续补传不反复修改。

HTTP 处理遵循 [OTLP 规范](https://opentelemetry.io/docs/specs/otlp/)：网络结果未知或断连可重试；`429/502/503/504` 退避并尊重 `Retry-After`；永久错误停止同批重试并记录拒绝。配置错误和永久拒绝不能伪装成成功交付。标准 `partial_success` 不重试整个请求，并报告 rejected 数量；LightMoni 自有链路推荐整批校验后提交，具体 ACK、错误码和冲突处理由公共契约统一。退避加入抖动；同一 SDK 不启动无界 goroutine/Promise；禁止将携带 Key 的请求日志明文输出。

## 浏览器接入

提供独立 `browser` 入口，避免把 Node 运行时适配器打进前端包。使用公开写入凭证，不能将主服务私有 Key 写进 JS。公开凭证、允许的 service/table、CORS、批次限额和节流由主干统一配置；公开凭证不授予读取数据权限。

示例包含运行时错误、未处理 Promise rejection、手工业务事件及简单页面性能指标。浏览器 SDK 直接连接公开主服务入口；页面退出时做尽力 flush，不能以 `sendBeacon` 返回值或页面即将关闭为依据宣称数据已经持久化。记录 HTTP trace 时需要用户配置允许注入 header 的目标，避免无差别改写跨域请求。

浏览器功能必须通过实际包体积、跨域和页面生命周期验证。完整自动埋点后置；官方 [Browser 指南](https://opentelemetry.io/docs/languages/js/getting-started/browser/) 当前把客户端埋点标为实验性，应据此选取可验证的子集。

## 阶段产物

1. **接口与夹具**：共同确认初始化 API、instrument/attribute 语义、exporter 接口和 ACK；提交 Go/TS 类型设计及相同语义的 OTLP 测试夹具。
2. **Go 基线**：先完成 Counter/Gauge/Histogram、冻结队列和内存 exporter；Agent 可以据此并行实现 collector。再完成 HTTP、日志/context、基础 trace 和退出逻辑。
3. **Node.js SDK**：对齐 Go 的用户语义与故障行为，补齐 HTTP/框架样例；版本锁定后明确支持的 Node 版本。
4. **浏览器子集**：独立入口、公开采集样例、错误/事件/指标；与主干完成真实 CORS 和限流联调。
5. **端到端交付**：Go/Node 各跑一份真实业务样例，经过 Agent、主服务和 ClickHouse，在大盘/日志中查到数据；记录故障注入和资源占用结果。

阶段 2 的 Go 嵌入接口是 Agent 的依赖节点。Go/Node 主流程达到可靠性验收后，再扩大自动埋点覆盖；不让浏览器实验性能力阻塞服务器采集上线。

## 验收标准

| 场景 | 必须验证的结果 |
| --- | --- |
| 多维计数 | 固定输入含至少三维组合，逐元组结果准确；属性顺序不同等价，属性类型不同不混合 |
| 并发与窗口切换 | Go race 检查通过；record 与 collect 交错不丢计数或双计数；collection 之间的 Delta 总和等于固定输入 |
| Gauge/Histogram | 最后观测、桶边界点、溢出桶、count/sum 正确；无新观测不凭空填零；错误单位/边界冲突可诊断 |
| 标签上限 | 低于限额无 overflow；超限不污染真实元组；Counter/Histogram 的真实组合加 overflow 总数等于输入；内存有界 |
| 多来源与重启 | 相同 service/维度的两个进程有不同来源；进程重启不沿用旧实例身份或旧 Delta；查询能明确合并 |
| 重试与新窗口 | 丢失一次 Agent ACK，再记录下一窗口；旧批重试使用同 ID/正文，新窗口独立；真实查询的总量不翻倍 |
| 队列与退出 | Agent 不可用时网络重试有界；内存限额/丢弃可见；恢复后按原时间补传；Flush 成功仅在 durable ACK 后，deadline 可退出 |
| 永久拒绝与部分成功 | `400/401/413` 等按契约停止同批重试，诊断可见；标准 partial_success 不重发已经接受的整批 |
| 嵌入 Agent | 主机 collector 使用相同 SDK API，exporter 直接提交队列；无需启动本机 HTTP；不会递归产生遥测 |
| 跨语言协议 | Go 与 Node 夹具经过同一解码/存储路径，类型、时间、trace 字段与维度语义一致；失败案例一致 |
| 日志 trace 预留 | 八种 SDK 不传 trace 仍正常上报，固定 trace/span 列留空；有效上下文与正文/属性分离，无上下文日志不自动生成 trace，作用域退出不串链；冻结发送保留记录时上下文 |
| 自动关联与跨服务 | 作用域内不逐条传 context 仍关联；并发任务隔离，嵌套/异常后恢复；Go → Node → Go 多跳 HTTP 同 trace、不同 span、父子关系和 flags/tracestate 保留 |
| 浏览器 | 私有 Key 不进入包；CORS、公开权限、批次限制、公开凭证失效、页面关闭尽力发送行为有真实验证 |

为上述数据正确性、故障边界和跨语言行为编写有效测试；不要只断言封装调用了某个 mock 方法。基准结果应报告环境、输入、队列上限、吞吐/延迟和内存，不能把期望数字写成已经验证的性能承诺。

## 主干开工前需冻结

1. table/header/resource 的精确定义、名称限制、默认行为，以及一个批次的 signal/table 边界。
2. durable ACK、批次 ID/正文冲突、永久拒绝、partial_success、服务端去重的可验证语义。
3. point 的来源身份、时间精度、Delta/Gauge/Histogram 存储字段、保留范围及属性编码。
4. 批次/请求/解压后大小、队列容量、维度限额和公开浏览器凭证/CORS 的统一默认值。
5. Go 嵌入 exporter 的公共类型和 Flush/Shutdown 边界，与 Agent 持久化队列接口一起冻结。
