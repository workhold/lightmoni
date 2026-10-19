# Go SDK

状态：**后续支持，仅保留源码**。不生成本次 SDK 发布包，接入页不提供安装选项；原生工具链、完整连接模式与故障矩阵尚未纳入本次发布验收。下文仅供后续开发参考，不构成当前发布支持承诺。当前可发布语言为 TypeScript/JavaScript、Python、Ruby，见 [SDK 总览](../README.md)。

根 module 中的包为 `github.com/lightmoni/lightmoni/sdk/go`，package 名 `moni`。SDK 使用进程内缓冲；需要独立磁盘队列时可明确选择 LightMoni Agent。

```go
// 按接入页配置所选路径的环境变量；缺省 direct。
client, err := moni.NewFromEnv("payment-api", "http", moni.Config{})
if err != nil { return err }
requests, err := client.Counter("http.requests", moni.MetricOptions{Unit: "{request}"})
if err != nil { return err }
requests.Add(ctx, 1, moni.Attributes{"route": "/payments", "method": "POST", "status": 200})
client.Logger(ctx).WithTable("app").Log("info", "completed", nil)
return client.Shutdown(shutdownCtx) // shutdownCtx 必须有 deadline。
```

`Counter.Add(context.Context,int64,Attributes)` 聚合同一完整维度组合，输出 monotonic Delta。`Gauge.Record` 与 `Histogram.Record` 接受 float64；Histogram 使用严格递增显式边界。`StartSpan`/`Start` 返回新的 context 和 span，日志从 context 读取 trace/span ID。`ExtractHTTP`、`InjectHTTP` 支持 W3C traceparent/tracestate。

`WithTable` 共享根状态；根 `Flush`/`Shutdown` 覆盖全部 table。表名 1–48 位、以小写字母开头，只含小写字母/数字/下划线，不能自填 log_/metric_/trace_ 前缀。同 table 同名指标不能改变类型、单位或 Histogram 边界。

Agent 内嵌采集时设置 `Config.Exporter`：实现 `Deliver(ctx, FrozenBatch) error`，在磁盘队列提交完成后返回 nil；必须响应 context 取消。`FrozenBatch.Clone()` 复制不可变正文。普通 error 会重试，`DeliveryError{Retryable:false,Err:...}` 是永久拒绝。HTTP 模式传送标准 OTLP Protobuf。

直连平台设置 `Mode: moni.ModeDirect`、`Config.Endpoint` 和 `Config.Key`，无需 Agent；每份 Key 可配置允许写入的逻辑 table 白名单，或显式允许所有 table，不绑定 service。一份 Key 可发任意 service，但指定 table 模式下只能上报到白名单中的 table（本例需允许 `http`、`app`）。显式 Agent 模式使用 `Mode: moni.ModeAgent`、`AgentEndpoint` 和可选 `LocalToken`，无需平台 Key；旧的无 mode `Endpoint/Key` 构造仍兼容。`UpdateKey` 更新直连 HTTP exporter 的 Key 并唤醒重试，保留已有批次。401/403 会保留队列并退避，等待修复。

容器、Serverless 或没有 Agent 的服务可将中心地址和 data key 通过 environment / Secret 注入，并调用 `moni.NewFromEnv("order-api", "business", moni.Config{})`。直连使用 `LIGHTMONI_MODE=direct`、`LIGHTMONI_ENDPOINT` 和 `LIGHTMONI_DATA_KEY`；通过节点使用 `LIGHTMONI_MODE=agent`、`LIGHTMONI_AGENT_ENDPOINT` 和可选的 `LIGHTMONI_LOCAL_TOKEN`；`LIGHTMONI_KEY` 仅是兼容别名。容器的 `localhost` 指向容器本身；同一 Docker 网络可使用 `http://lightmoni:8080`，Docker Desktop 访问宿主机可使用 `http://host.docker.internal:端口`。直连缓冲只在进程内，需要本地磁盘缓存时使用 Agent。

显式 direct 只读取 data key，显式 agent 只读取 local token；对应 `_FILE` 注入和所选来源冲突校验继续有效。失败只在原路径重试。标准 HTTP agent 的 `RefreshConfig` 也走 Agent/local token；自定义 exporter 的独立规则配置、direct/auto 保持兼容。环境块切换与 ACK 边界见 [选择上报方式](../README.md#选择上报方式)。

默认每 10 秒 collection；QueueBytes/BufferBytes 各 8 MiB、QueueBatches 256、单批 1 MiB、每 instrument 2000 维度、256 instruments。维度超限归入 `otel.metric.overflow=true`；队列/缓冲满明确丢弃新数据并更新 Stats。属性只支持 string/bool/int/int32/int64/float32/float64，保留类型。记录 API 不等待网络，非法输入在 Stats 中可见。

Flush 等待调用边界内批次的持久化 ACK，后续记录不会无限拖长本次 Flush。失败、超时、已发生的丢弃不能返回成功；数据丢弃和永久拒绝会持续使当前实例的 Flush/Shutdown 返回错误，避免隐藏已损失的数据。SDK 进程在 Agent ACK 之前崩溃可能丢失内存数据。ACK 丢失时重试相同 ID/创建时间/正文，服务端去重仍由主服务负责。

从仓库根运行样例：

```sh
go run ./examples/sdk/go -endpoint http://127.0.0.1:4318
go test -race ./sdk/go
```

直连主服务时用 `LIGHTMONI_DATA_KEY` 设置允许写入业务 table 的凭证，并将 endpoint 改为主服务地址。样例输出统计，不输出 Key。

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

默认每 30 秒上报实例心跳和内部诊断，独立于业务采集周期，空闲进程也会发送。中心自动归入系统 SDK 表，使用原业务 table 的权限；WithTable 共享生命周期。可通过 `Config.DisableSelfTelemetry=true` 关闭。退出前仍需 Shutdown；完整语义见 [SDK 契约](../README.md#内部监控)。

日志上报规则与动态停报：支持 Config.LogSampling（按逻辑表）、Config.Disabled，以及 UpdateLogSampling / SetReportingEnabled / RefreshConfig(ctx)。HTTP 入口默认每 30 秒更新；启用业务生产前可显式等待 RefreshConfig。SDK 整体停报影响全部信号；UID 排除和采样只影响业务日志，不改变 metric 聚合。完整配置与保留边界见 [上报规则契约](../README.md#sdk-停报与日志上报规则)。
