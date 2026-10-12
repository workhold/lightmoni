# Mac 本机 Agent + SDK 封装 demo

业务代码通过 [`telemetry/monitor.go`](telemetry/monitor.go) 统一使用 LightMoni SDK。封装提供 HTTP 请求计数、耗时、并发数、链路上下文和业务日志；SDK 的实例心跳及内部诊断自动上报。业务写入 `demo_http` / `demo_app`，自监控写入独立系统 SDK 表。

中心运行在 http://localhost:18380 。本机 Agent 运行在 http://127.0.0.1:4318 ，中心 Key 只存于本机 Agent 配置；SDK 使用 Agent 的本地接入令牌。

```sh
# 先启动本机 Agent；配置由数据接入页生成，Key 不写入示例源码。
go build -o .lightmoni/mac-self-monitor/lightmoni-agent ./cmd/lightmoni-agent
.lightmoni/mac-self-monitor/lightmoni-agent run --config .lightmoni/mac-self-monitor/agent.json

# 另一个终端加载本地生成的 SDK 环境变量，启动业务和演示流量。
set -a
. .lightmoni/mac-self-monitor/demo.env
set +a
go run ./examples/self-monitoring --traffic

# 正常订单 / 可控失败；每 10 次演示流量会产生 1 次失败。
curl -X POST http://127.0.0.1:18480/orders
curl -X POST 'http://127.0.0.1:18480/orders?fail=1'
```

停止测试可向两个进程发送 Ctrl-C；SDK 退出时有 5 秒 Shutdown 截止时间。在线 Agent 默认 90 秒无心跳离线（控制周期超过 30 秒时使用三倍周期）；在线 SDK 为 90 秒无新心跳离线。重新启动 Agent 使用同一配置目录保留 Agent 身份；业务重启会生成新的 SDK 进程实例身份。

内置大盘：

- [中心监控](http://localhost:18380/dashboards/system-center)：QPS、首次确认接收量、请求错误/耗时、队列、内存和中心日志。
- [Agent 监控](http://localhost:18380/dashboards/system-agent)：在线数、分组、积压、最老批次年龄、采集异常和执行日志。
- [SDK 监控](http://localhost:18380/dashboards/system-sdk)：在线实例、重试/丢弃/溢出、缓冲和内部诊断日志。

在对应图表的告警设置中，可以配置「在线数低于 1」等规则；内置在线总数查询在完全离线时返回 0，便于配置数量告警。示例验证规则仅在告警列表产生事件，没有绑定外部通知目标。
