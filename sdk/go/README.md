# Go SDK

根 module 中的包为 `github.com/lightmoni/lightmoni/sdk/go`，package 名 `moni`。不使用磁盘；本机 Agent 是默认的持久化边界。

```go
client, err := moni.New(moni.Config{
    Service: "payment-api", Table: "http", Endpoint: "http://127.0.0.1:4318",
})
if err != nil { return err }
requests, err := client.Counter("http.requests", moni.MetricOptions{Unit: "{request}"})
if err != nil { return err }
requests.Add(ctx, 1, moni.Attributes{"route": "/payments", "method": "POST", "status": 200})
client.WithTable("app").Log(ctx, "info", "completed", nil)
return client.Shutdown(shutdownCtx) // shutdownCtx 必须有 deadline。
```

`Counter.Add(context.Context,int64,Attributes)` 聚合同一完整维度组合，输出 monotonic Delta。`Gauge.Record` 与 `Histogram.Record` 接受 float64；Histogram 使用严格递增显式边界。`StartSpan`/`Start` 返回新的 context 和 span，日志从 context 读取 trace/span ID。`ExtractHTTP`、`InjectHTTP` 支持 W3C traceparent/tracestate。

`WithTable` 共享根状态；根 `Flush`/`Shutdown` 覆盖全部 table。表名 1–48 位、以小写字母开头，只含小写字母/数字/下划线，不能自填 log_/metric_/trace_ 前缀。同 table 同名指标不能改变类型、单位或 Histogram 边界。

Agent 内嵌采集时设置 `Config.Exporter`：实现 `Deliver(ctx, FrozenBatch) error`，在磁盘队列提交完成后返回 nil；必须响应 context 取消。`FrozenBatch.Clone()` 复制不可变正文。普通 error 会重试，`DeliveryError{Retryable:false,Err:...}` 是永久拒绝。HTTP 模式传送标准 OTLP Protobuf。

直接主服务使用 `Config.Key`；每份 Key 可配置允许写入的逻辑 table 白名单，或显式允许所有 table，不绑定 service。一份 Key 可发任意 service，但指定 table 模式下只能上报到白名单中的 table（本例需允许 `http`、`app`）。SDK→Agent 不必配置私有 Key。`UpdateKey` 更新直连 HTTP exporter 的 Key 并唤醒重试，保留已有批次。401/403 会保留队列并退避，等待修复。

默认每 10 秒 collection；QueueBytes/BufferBytes 各 8 MiB、QueueBatches 256、单批 1 MiB、每 instrument 2000 维度、256 instruments。维度超限归入 `otel.metric.overflow=true`；队列/缓冲满明确丢弃新数据并更新 Stats。属性只支持 string/bool/int/int32/int64/float32/float64，保留类型。记录 API 不等待网络，非法输入在 Stats 中可见。

Flush 等待调用边界内批次的持久化 ACK，后续记录不会无限拖长本次 Flush。失败、超时、已发生的丢弃不能返回成功；数据丢弃和永久拒绝会持续使当前实例的 Flush/Shutdown 返回错误，避免隐藏已损失的数据。SDK 进程在 Agent ACK 之前崩溃可能丢失内存数据。ACK 丢失时重试相同 ID/创建时间/正文，服务端去重仍由主服务负责。

从仓库根运行样例：

```sh
go run ./examples/sdk/go -endpoint http://127.0.0.1:4318
go test -race ./sdk/go
```

直连主服务时用 `LIGHTMONI_KEY` 设置允许写入业务 table 的凭证，并将 endpoint 改为主服务地址。样例输出统计，不输出 Key。
