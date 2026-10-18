# Rust SDK

推荐新的五参数 Record/record 业务接口：初始化 service/env，可选版本/实例，SDK 自动聚合发送。完整语义、count总值规则、SQL字段与新样例见 [统一打点](../README.md#通用业务打点go--nodejs--python--rust)。下面原接口继续兼容。


Rust 1.85+，Cargo.toml / Cargo.lock 固定依赖。源码路径依赖：

包内 Cargo.lock 用于在 SDK 目录直接构建与运行示例。作为业务依赖时使用业务工程自己的 Cargo.lock；请锁定业务依赖并使用与解析结果匹配的 Rust 工具链。

~~~toml
[dependencies]
lightmoni = { path = "/path/to/sdk/rust" }
~~~

~~~rust
use lightmoni::{Client, Attributes};
use std::time::Duration;
let mon = Client::new("order-api", "business", "http://127.0.0.1:4318", "")?;
mon.counter("orders_created")?.add(1, &Attributes::from([
    ("region".into(), "cn".into())
]));
mon.with_span("create_order", &Attributes::new(), None, |scoped, _| {
    scoped.log("info", "order created", &Attributes::new(), None);
})?;
mon.shutdown(Duration::from_secs(5))?;
~~~

with_table 返回共享状态的 Client；Attributes 保留 string/bool/i64/f64 类型。Counter 接受 i64，Gauge / Histogram 接受 f64；histogram 自定义桶，instrument 设置单位。TraceContext::extract / context.inject 处理 W3C header；Drop / end 幂等结束 span，不隐式发送网络请求。

flush(Duration) 同步阻塞，Tokio 内使用 spawn_blocking，由应用定时调度。with_limits 调整容量，update_key / stats 支持诊断。完整边界见 [SDK 契约](../README.md)。运行 cargo run --locked --manifest-path sdk/rust/Cargo.toml --example demo。

`with_trace(&context)` 返回不可变绑定客户端，`with_table` 保留绑定；`log(..., None)` 和 `start_span(..., None)` 自动读取该绑定。将绑定客户端 clone 到任务即可保留跨线程/await 关联，无全局 thread-local。`with_span` 是同步回调，正常返回或 panic 时结束 span；异步处理用 `start_span` 创建 span 和绑定客户端，持有 span 到 await 完成后再 end，不把 Future 作为同步回调结果。应用返回业务 Result 时可显式 set_error。HTTP/消息入口用提取结果作为 parent，出站通过 `client.trace_headers()` 导出 W3C header，`current_trace()` 可读取当前绑定。

## SDK 自监控

默认每 30 秒上报实例心跳和内部诊断，空闲进程也会发送；原生运行时的后台线程同时 Flush 当前业务窗口。中心统一归入 lightmoni_log/lightmoni_metric_*，component=sdk；无密钥不产生自身遥测；WithTable 共享生命周期。可通过 `Limits { self_telemetry:false, ..Limits::default() }` 关闭。退出前仍需 Shutdown；完整语义见 [SDK 契约](../README.md#内部监控)。
