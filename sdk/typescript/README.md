# TypeScript SDK

推荐新的五参数 Record/record 业务接口：初始化 service/env，可选版本/实例，SDK 自动聚合发送。完整语义、count总值规则、SQL字段与新样例见 [统一打点](../README.md#通用业务打点go--nodejs--python--rust)。下面原接口继续兼容。

新record按表选择一个上报聚合周期，默认30秒，支持10秒、30秒、1分钟、5分钟、10分钟、30分钟、1小时。中心配置通过refreshConfig/后台轮询下发；下文10秒collection为后台收集检查间隔，record只自动发送已结束的固定窗口。


Node.js 20+，业务 API 使用标准 OTLP JSON；没有运行时 npm 依赖。浏览器入口不导入 Node 的 AsyncLocalStorage。

```typescript
import { createLightMoni } from "@lightmoni/sdk";
const mon = createLightMoni({ service: "payment-api", table: "http", endpoint: "https://monitor.example.com" });
const count = mon.counter("http.requests");
count.add(1, { route: "/payments", method: "POST", status: 200 });
await mon.withTable("app").withSpan("payment.create", async () => {
  await Promise.resolve();
  mon.withTable("app").log("info", "completed");
});
await mon.shutdown({ timeoutMs: 5000 });
```

Counter 支持非负安全整数或 bigint，输出 Int64 Delta；Gauge 最后值和 Histogram 接受有限 number。数值属性中的整数保留 Int64，超出 JS 安全整数时使用 bigint；int64/时间/count 在 OTLP JSON 中是十进制字符串。traceId/spanId 是 OTLP JSON 的十六进制字符串。属性键排序，类型保留，记录时复制维度，因此随后修改调用方对象不会篡改数据。

`mon.meter` 也可访问 counter/gauge/histogram；`withTable` 共享生命周期，根 flush/shutdown 覆盖全部。`withSpan` 自动创建/继承 span、通过 AsyncLocalStorage 绑定上下文，并在同步返回、异步完成或异常时结束；普通 `log(...)` 自动关联，嵌套后恢复外层。`withTrace(context, action)` 可绑定已有上下文。`contextProvider` 可桥接外部上下文，当前 SDK 作用域优先。无上下文普通日志不生成 trace。

HTTP 入口使用 `traceHandler`，出站使用 `mon.fetch`；下游服务继续同一个 trace ID 并创建自己的 span。这里的 `mon` 为已初始化客户端：

```typescript
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { traceHandler } from "@lightmoni/sdk";
const handle = traceHandler(mon, "orders HTTP", async (req: IncomingMessage, res: ServerResponse) => {
  mon.log("info", "request started");
  const response = await mon.fetch("http://order-service/orders");
  mon.log("info", "downstream completed");
  res.end(String(response.status));
}, req => new Headers({
  traceparent: String(req.headers.traceparent ?? ""),
  tracestate: String(req.headers.tracestate ?? ""),
}));
createServer((req, res) => {
  void handle(req, res).catch(() => { res.statusCode = 500; res.end(); });
}).listen(8080);
```

`extractTrace` / `injectTrace` 处理 W3C header，`currentTrace()` 返回当前快照。浏览器用 `withSpan` 回调的绑定客户端：`await mon.withSpan('click', async scoped => { await scoped.fetch(url); scoped.log('info','done'); })`；或 `mon.withTrace(context)` 创建绑定客户端。浏览器异步任务不修改全局当前 trace，`withTable` 保留绑定。完整第三方框架/日志 appender 埋点尚未提供。

SDK仅直连中心，显式配置中心公网引导URL和SDK Key。管理员登记内网IP及端口后自动同步，内网优先、公网备用，详见[中心地址同步](../../docs/center-endpoints.md)。

SDK仅直连中心，显式配置中心公网引导URL和SDK Key。管理员登记内网IP及端口后自动同步，内网优先、公网备用，详见[中心地址同步](../../docs/center-endpoints.md)。

SDK仅直连中心，显式配置中心公网引导URL和SDK Key。管理员登记内网IP及端口后自动同步，内网优先、公网备用，详见[中心地址同步](../../docs/center-endpoints.md)。

```sh
cd sdk/typescript
npm ci
npm test
```

从仓库根运行：`node examples/sdk/node/index.mjs`。环境变量 `LIGHTMONI_ENDPOINT`、`LIGHTMONI_KEY`、`LIGHTMONI_SERVICE`、`LIGHTMONI_COUNT` 可修改接入参数。

浏览器使用 `@lightmoni/sdk/browser` 的 `installBrowserMonitor` 或 `createLightMoni`；采集入口通过业务后端转发，后端持有 SDK Key；浏览器页面无需 Key。示例在 `examples/sdk/browser/index.html`；先 build，再执行 `node examples/sdk/browser/server.mjs --config .lightmoni/agent-smoke.json`，访问 `http://127.0.0.1:18418`。也可通过 `LIGHTMONI_ENDPOINT` 和 `LIGHTMONI_KEY` 环境变量配置 demo 后端。包含手工事件、运行时错误、未处理 rejection 和简单 navigation 性能指标。页面关闭/隐藏时仅尽力 flush，不能宣称已经 ACK；没有持久化离线队列或会话回放。

## SDK 自监控

默认每 30 秒上报实例心跳和内部诊断，独立于业务采集周期，空闲进程也会发送。中心统一归入 lightmoni_log/lightmoni_metric_*，component=sdk；无密钥不产生自身遥测；WithTable 共享生命周期。可通过 `selfTelemetry:false` 关闭。退出前仍需 Shutdown；完整语义见 [SDK 契约](../README.md#内部监控)。

日志上报规则与动态停报：Node / 浏览器支持 logSampling（按逻辑表）、disabled，以及 updateLogSampling / setReportingEnabled / await refreshConfig()。HTTP 入口默认每 30 秒更新；启用业务生产前可显式等待 refreshConfig。浏览器业务后端同时转发 GET /v1/sdk-config，不向页面提供中心 Key。SDK 整体停报影响全部信号；UID 排除和采样只影响业务日志。完整配置见 [上报规则契约](../README.md#sdk-停报与日志上报规则)。
