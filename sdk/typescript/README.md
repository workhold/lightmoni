# TypeScript SDK

Node.js 20+，业务 API 使用标准 OTLP JSON；没有运行时 npm 依赖。浏览器入口不导入 Node 的 AsyncLocalStorage。

```typescript
import { createLightMoni, withTrace } from "@lightmoni/sdk";
const mon = createLightMoni({ service: "payment-api", table: "http", endpoint: "http://127.0.0.1:4318" });
const count = mon.counter("http.requests");
count.add(1, { route: "/payments", method: "POST", status: 200 });
const span = mon.withTable("app").startSpan("payment.create");
await withTrace(span.context, async () => { mon.withTable("app").log("info", "completed"); });
span.end();
await mon.shutdown({ timeoutMs: 5000 });
```

Counter 支持非负安全整数或 bigint，输出 Int64 Delta；Gauge 最后值和 Histogram 接受有限 number。数值属性中的整数保留 Int64，超出 JS 安全整数时使用 bigint；int64/时间/count 在 OTLP JSON 中是十进制字符串。traceId/spanId 是 OTLP JSON 的十六进制字符串。属性键排序，类型保留，记录时复制维度，因此随后修改调用方对象不会篡改数据。

`mon.meter` 也可访问 counter/gauge/histogram；`withTable` 共享生命周期，根 flush/shutdown 覆盖全部。`extractTrace`/`injectTrace` 支持 W3C header；`withTrace` 使用 AsyncLocalStorage 传播 Node 请求上下文。自动框架埋点尚未交付；样例展示手工业务和请求上下文接入。

配置与可靠性默认值同 Go SDK：10 秒 collection、有界 8 MiB 活跃缓冲和 8 MiB 待发送队列、256 批、1 MiB 单批、2000 维度、256 instruments；可按 options 调整。超限与非法输入看 `stats()`。快照冻结后重试 ID/创建时间/正文不变，读者前进 Delta 不丢掉原待发送窗口；队列丢失或永久拒绝会让该实例 flush/shutdown 持续返回错误。SDK 未获 Agent ACK 前崩溃会丢内存；持久化和服务端去重由 Agent/主服务完成。自定义 exporter 必须响应 AbortSignal，并在 durable commit 后成功返回。

直连中心同时配置 `endpoint` 和 `key`，无需 Agent。每份 Key 可配置逻辑 table 白名单或显式允许所有 table、不绑定 service；本例需允许 `http`、`app`，使用 `withTable` 也需授权相应 table。Agent 路径不需要 SDK 保管中心 Key；Agent 开启本地令牌时，`key` 传该令牌。`updateKey` 可修复直连 401/403，保留冻结队列。标准 OTLP partialSuccess 不重发整批，拒绝记录可见。

Node.js 容器、Serverless 等服务可用 `process.env.LIGHTMONI_ENDPOINT`、`process.env.LIGHTMONI_KEY` 传入配置，通过 environment / Secret 注入值。容器的 `localhost` 指向容器本身；同一 Docker 网络可使用 `http://lightmoni:8080`，Docker Desktop 访问宿主机可使用 `http://host.docker.internal:端口`。直连缓冲只在进程内，需要本地磁盘缓存时使用 Agent。浏览器继续使用下文的业务后端转发。

```sh
cd sdk/typescript
npm ci
npm test
```

从仓库根运行：`node examples/sdk/node/index.mjs`。环境变量 `LIGHTMONI_ENDPOINT`、`LIGHTMONI_KEY`、`LIGHTMONI_SERVICE`、`LIGHTMONI_COUNT` 可修改接入参数。

浏览器使用 `@lightmoni/sdk/browser` 的 `installBrowserMonitor` 或 `createLightMoni`；采集入口通过业务后端转发，后端持有仅允许 `web` table 的 Key；浏览器页面无需 Key。示例在 `examples/sdk/browser/index.html`；先 build，再执行 `node examples/sdk/browser/server.mjs --config .lightmoni/agent-smoke.json`，访问 `http://127.0.0.1:18418`。也可通过 `LIGHTMONI_ENDPOINT` 和 `LIGHTMONI_KEY` 环境变量配置 demo 后端。包含手工事件、运行时错误、未处理 rejection 和简单 navigation 性能指标。页面关闭/隐藏时仅尽力 flush，不能宣称已经 ACK；没有持久化离线队列或会话回放。

## SDK 自监控

默认每 30 秒上报实例心跳和内部诊断，独立于业务采集周期，空闲进程也会发送。中心自动归入系统 SDK 表，使用原业务 table 的权限；WithTable 共享生命周期。可通过 `selfTelemetry:false` 关闭。退出前仍需 Shutdown；完整语义见 [SDK 契约](../README.md#内部监控)。

日志上报规则与动态停报：Node / 浏览器支持 logSampling（按逻辑表）、disabled，以及 updateLogSampling / setReportingEnabled / await refreshConfig()。HTTP 入口默认每 30 秒更新；启用业务生产前可显式等待 refreshConfig。浏览器业务后端同时转发 GET /v1/sdk-config，不向页面提供中心 Key。SDK 整体停报影响全部信号；UID 排除和采样只影响业务日志。完整配置见 [上报规则契约](../README.md#sdk-停报与日志上报规则)。
