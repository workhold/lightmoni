# Rust SDK

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
let mut span = mon.start_span("create_order", &Attributes::new(), None)?;
mon.log("info", "order created", &Attributes::new(), Some(&span.context));
span.end();
mon.shutdown(Duration::from_secs(5))?;
~~~

with_table 返回共享状态的 Client；Attributes 保留 string/bool/i64/f64 类型。Counter 接受 i64，Gauge / Histogram 接受 f64；histogram 自定义桶，instrument 设置单位。TraceContext::extract / context.inject 处理 W3C header；Drop / end 幂等结束 span，不隐式发送网络请求。

flush(Duration) 同步阻塞，Tokio 内使用 spawn_blocking，由应用定时调度。with_limits 调整容量，update_key / stats 支持诊断。完整边界见 [SDK 契约](../README.md)。运行 cargo run --locked --manifest-path sdk/rust/Cargo.toml --example demo。

## SDK 自监控

默认每 30 秒上报实例心跳和内部诊断，空闲进程也会发送；原生运行时的后台线程同时 Flush 当前业务窗口。中心自动归入系统 SDK 表，使用原业务 table 的权限；WithTable 共享生命周期。可通过 `Limits { self_telemetry:false, ..Limits::default() }` 关闭。退出前仍需 Shutdown；完整语义见 [SDK 契约](../README.md#内部监控)。
