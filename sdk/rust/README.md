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
let mon = Client::from_env("order-api", "business")?;
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

## 上报路径

`Client::from_env` 默认 direct，服务器、容器与 Serverless 均可使用，不依赖节点助手。两种显式模式只读取自己路径的凭据；失败后沿原路重试。保留 `auto` 兼容旧配置。

直连平台：

~~~sh
unset LIGHTMONI_AGENT_ENDPOINT LIGHTMONI_LOCAL_TOKEN LIGHTMONI_LOCAL_TOKEN_FILE LIGHTMONI_DATA_KEY_FILE LIGHTMONI_KEY
export LIGHTMONI_MODE=direct
export LIGHTMONI_ENDPOINT='https://lightmoni.example.com'
export LIGHTMONI_DATA_KEY='<业务 data key>'
~~~

通过 LightMoni Agent：

~~~sh
unset LIGHTMONI_ENDPOINT LIGHTMONI_DATA_KEY LIGHTMONI_DATA_KEY_FILE LIGHTMONI_KEY LIGHTMONI_LOCAL_TOKEN LIGHTMONI_LOCAL_TOKEN_FILE
export LIGHTMONI_MODE=agent
export LIGHTMONI_AGENT_ENDPOINT='http://127.0.0.1:4318'
# 仅在 Agent 启用本地鉴权时注入 LIGHTMONI_LOCAL_TOKEN 或 LIGHTMONI_LOCAL_TOKEN_FILE。
~~~

容器中的 `127.0.0.1` 指向当前容器，地址应填写业务实际可达的 Agent。Agent 成功确认代表本地持久队列接收，最终上传受队列容量和重放期限限制；direct 使用进程内有限缓冲。节点采集和诊断职责独立于 SDK 路由。所选凭据仍校验来源冲突和 Secret 文件；未选路径的凭据和文件不读取。

运行配置隔离测试：`cargo test --locked --manifest-path sdk/rust/Cargo.toml`。

`with_trace(&context)` 返回不可变绑定客户端，`with_table` 保留绑定；`log(..., None)` 和 `start_span(..., None)` 自动读取该绑定。将绑定客户端 clone 到任务即可保留跨线程/await 关联，无全局 thread-local。`with_span` 是同步回调，正常返回或 panic 时结束 span；异步处理用 `start_span` 创建 span 和绑定客户端，持有 span 到 await 完成后再 end，不把 Future 作为同步回调结果。应用返回业务 Result 时可显式 set_error。HTTP/消息入口用提取结果作为 parent，出站通过 `client.trace_headers()` 导出 W3C header，`current_trace()` 可读取当前绑定。

## SDK 自监控

默认每 30 秒上报实例心跳和内部诊断，空闲进程也会发送；原生运行时的后台线程同时 Flush 当前业务窗口。中心自动归入系统 SDK 表，使用原业务 table 的权限；WithTable 共享生命周期。可通过 `Limits { self_telemetry:false, ..Limits::default() }` 关闭。退出前仍需 Shutdown；完整语义见 [SDK 契约](../README.md#内部监控)。
