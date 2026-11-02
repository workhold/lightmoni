# Go SDK

推荐新的五参数 Record/record 业务接口：初始化 service/env，可选版本/实例，SDK 自动聚合发送。完整语义、count总值规则、SQL字段与新样例见 [统一打点](../README.md#通用业务打点go--nodejs--python--rust)。下文 instrument API 用于低层指标与自监控采集。

新Record按表选择一个上报聚合周期，默认30秒，支持10秒、30秒、1分钟、5分钟、10分钟、30分钟、1小时。中心配置通过RefreshConfig/后台轮询下发；下文10秒collection为后台收集检查间隔，Record只自动发送已结束的固定窗口。


SDK仅直连中心，显式配置中心公网引导URL和SDK Key。管理员登记内网IP及端口后自动同步，内网优先、公网备用，详见[中心地址同步](../../docs/center-endpoints.md)。

```go
client, err := moni.New(moni.Config{
    Service: "payment-api", Table: "http", Endpoint: "https://monitor.example.com",
})
if err != nil { return err }
requests, err := client.Counter("http.requests", moni.MetricOptions{Unit: "{request}"})
if err != nil { return err }
requests.Add(ctx, 1, moni.Attributes{"route": "/payments", "method": "POST", "status": 200})
client.Logger(ctx).WithTable("app").Log("info", "completed", nil)
return client.Shutdown(shutdownCtx) // shutdownCtx 必须有 deadline。
```

`Counter.Add(context.Context,int64,Attributes)` 聚合同一完整维度组合，输出 monotonic Delta。`Gauge.Record` 与 `Histogram.Record` 接受 float64；Histogram 使用严格递增显式边界。`StartSpan`/`Start` 返回新的 context 和 span，日志从 context 读取 trace/span ID。`ExtractHTTP`、`InjectHTTP` 支持 W3C traceparent/tracestate。

`WithTable` 共享根状态；根 `Flush`/`Shutdown` 覆盖全部 table。表名 1–48 位、以小写字母开头，只含小写字母/数字/下划线，不能自填 log_/metric_/trace_ 前缀。同 table 同名指标不能改变类型、单位或 Histogram 边界。

SDK仅直连中心，显式配置中心公网引导URL和SDK Key。管理员登记内网IP及端口后自动同步，内网优先、公网备用，详见[中心地址同步](../../docs/center-endpoints.md)。

SDK仅直连中心，显式配置中心公网引导URL和SDK Key。管理员登记内网IP及端口后自动同步，内网优先、公网备用，详见[中心地址同步](../../docs/center-endpoints.md)。

SDK仅直连中心，显式配置中心公网引导URL和SDK Key。管理员登记内网IP及端口后自动同步，内网优先、公网备用，详见[中心地址同步](../../docs/center-endpoints.md)。

默认每 10 秒 collection；QueueBytes/BufferBytes 各 8 MiB、QueueBatches 256、单批 1 MiB、每 instrument 2000 维度、256 instruments。维度超限归入 `otel.metric.overflow=true`；队列/缓冲满明确丢弃新数据并更新 Stats。属性只支持 string/bool/int/int32/int64/float32/float64，保留类型。记录 API 不等待网络，非法输入在 Stats 中可见。

SDK仅直连中心，显式配置中心公网引导URL和SDK Key。管理员登记内网IP及端口后自动同步，内网优先、公网备用，详见[中心地址同步](../../docs/center-endpoints.md)。

从仓库根运行样例：

```sh
go run ./examples/sdk/go -endpoint https://monitor.example.com
go test -race ./sdk/go
```

直连主服务时用 `LIGHTMONI_KEY` 设置允许写入业务 table 的凭证，并将 endpoint 改为主服务地址。样例输出统计，不输出 Key。

## 自动关联与 HTTP 传播

HTTP 入口包一层 `client.TraceHandler(handler)`，自动继承上游 trace 或创建请求根 span。业务用 `client.Logger(r.Context())` 绑定一次，随后 `logger.Log(level,body,attrs)` 自动关联；嵌套操作使用 `StartSpan` 返回的 context 创建子 logger。

```go
httpClient := &http.Client{Transport: moni.TraceTransport{}, Timeout: 5*time.Second}
handler := client.TraceHandler(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
    logger := client.Logger(r.Context()).WithTable("app")
    logger.Log("info", "request started", nil)
    request, err := http.NewRequestWithContext(r.Context(), "GET", "http://order-service/orders", nil)
    if err != nil { http.Error(w, err.Error(), 500); return }
    response, err := httpClient.Do(request) // 自动发送 traceparent / tracestate。
    if err != nil { http.Error(w, err.Error(), 502); return }
    defer response.Body.Close()
    logger.Log("info", "downstream completed", nil)
}))
// 将 handler 注册到业务 HTTP server，退出时仍需 Shutdown。
```

`TraceTransport.Base` 可包已有 RoundTripper；传播时复制请求/header，不改调用方对象。请求必须带当前 context，才能串起跨服务链路。`Config.TraceContextProvider` 可从业务 context / 已有 OpenTelemetry 返回 LightMoni TraceContext；已有有效 LightMoni context 优先，provider 在日志记录时读取一次。无 trace 的普通日志保持字段为空。完整语义见 [SDK 约定](../README.md#自动关联与跨服务传播)。

## SDK 自监控

默认每 30 秒上报实例心跳和内部诊断，独立于业务采集周期，空闲进程也会发送。中心统一归入 lightmoni_log/lightmoni_metric_*，component=sdk；无密钥不产生自身遥测；WithTable 共享生命周期。可通过 `Config.DisableSelfTelemetry=true` 关闭。退出前仍需 Shutdown；完整语义见 [SDK 契约](../README.md#内部监控)。

日志上报规则与动态停报：支持 Config.LogSampling（按逻辑表）、Config.Disabled，以及 UpdateLogSampling / SetReportingEnabled / RefreshConfig(ctx)。HTTP 入口默认每 30 秒更新；启用业务生产前可显式等待 RefreshConfig。SDK 整体停报影响全部信号；UID 排除和采样只影响业务日志，不改变 metric 聚合。完整配置与保留边界见 [上报规则契约](../README.md#sdk-停报与日志上报规则)。
