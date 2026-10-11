# LightMoni SDK

所有原生 SDK 支持指标、日志和链路，默认连接本机 Agent http://127.0.0.1:4318，也支持带 Key 直连主服务。配置业务 service、逻辑 table；Key 必须允许该 table。withTable / with_table 共享根客户端生命周期。

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

共享 HTTP 测试检查聚合、Int64 精度、Gauge 不补零、Histogram 桶、W3C 父上下文、日志/span 关联、跨 table、overflow、503/429/401/损坏 ACK/连接断开丢 ACK、冻结重试与下一窗口、永久拒绝、partialSuccess 和容量损失。真实 Agent 和隔离 ClickHouse 验收见 [验收证据](../docs/evidence/multilang-sdk/README.md)。
