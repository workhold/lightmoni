# C# / .NET SDK

.NET 8+，只用系统库，源码引用或打本地 NuGet 包：

~~~sh
dotnet add YourApp.csproj reference ./sdk/dotnet/LightMoni.csproj
dotnet run --project examples/sdk/dotnet/Demo.csproj
dotnet pack sdk/dotnet/LightMoni.csproj
~~~

~~~csharp
using LightMoni;
var mon = new Client("order-api", "business");
mon.Counter("orders_created").Add(1, new Dictionary<string, object> { ["region"] = "cn" });
using (var span = mon.StartSpan("create_order"))
using (var scope = span.MakeCurrent())
    mon.Log("info", "order created");
await mon.ShutdownAsync(TimeSpan.FromSeconds(5));
~~~

WithTable 共享生命周期；Counter 接受 long，Gauge / Histogram 接受 double；boundaries 参数设置桶。TraceContext.Extract / context.Inject 处理 W3C header；span/log 支持可选上下文；Dispose / End 幂等结束 span。构造函数支持 endpoint/key/Limits；FlushAsync 支持 timeout 和 CancellationToken，应用自行调度。UpdateKey / Stats 支持修复与诊断。完整边界见 [SDK 契约](../README.md)。

`WithSpanAsync<T>(name, action, attributes, parent)` 可一次绑定异步请求/任务，普通日志自动关联；AsyncLocal 隔离并发 Task、保留 await 上下文，嵌套/异常后恢复。`TraceContext.Current` / `context.Activate()` 捕获和激活已有上下文。HTTP/消息入口通过 `TraceContext.Extract(headers)` 取得 parent；出站使用 `new HttpClient(new TraceHttpHandler())` 自动传播，或 `TraceContext.InjectCurrent()` 导出 W3C header 到消息 metadata。无作用域普通日志保留空 trace。

## SDK 自监控

默认每 30 秒上报实例心跳和内部诊断，空闲进程也会发送；原生运行时的后台线程同时 Flush 当前业务窗口。中心自动归入系统 SDK 表，使用原业务 table 的权限；WithTable 共享生命周期。可通过 `new Limits(SelfTelemetry:false)` 关闭。退出前仍需 Shutdown；完整语义见 [SDK 契约](../README.md#内部监控)。
