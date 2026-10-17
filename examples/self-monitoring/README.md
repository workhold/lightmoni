# Mac 本机 LightMoni Agent + SDK 封装 demo

本例保留为 Go 业务 SDK 的可运行示例；中心和 Agent 已迁移为 Node.js / TypeScript。Go 工具链仅用于此业务示例，平台运行不依赖 Go。迁移规格见 [SDD 007](../../specs/007-node-runtime-migration/spec.md)。

业务代码通过 [`telemetry/monitor.go`](telemetry/monitor.go) 统一使用 LightMoni SDK。封装提供 HTTP 请求计数、耗时、并发数、链路上下文和业务日志；SDK 的实例心跳及内部诊断自动上报。业务写入 `demo_http` / `demo_app`，自监控写入独立系统 SDK 表。

示例中心地址为 [http://localhost:18380](http://localhost:18380)，本机执行节点地址为 [http://127.0.0.1:4318](http://127.0.0.1:4318)。中心 Key 只存于本机 LightMoni Agent 配置；SDK 使用执行节点的本地接入令牌。

```sh
# 在仓库根目录构建 Node 中心、执行节点和网页。
npm run setup
npm run build
# 在单独终端启动中心；按环境填写 ClickHouse 连接变量。
LIGHTMONI_DATA=.lightmoni/mac-self-monitor/center LIGHTMONI_ADDR=127.0.0.1:18380 LIGHTMONI_EXTERNAL_URL=http://localhost:18380 node runtime/dist/server/main.js

# 另一个终端启动本机执行节点；配置使用本机独立数据目录，Key 不写入示例源码。
node runtime/dist/agent/main.js run --config .lightmoni/mac-self-monitor/agent.json

# 另一个终端加载本地生成的 SDK 环境变量，启动业务和演示流量。
set -a
. .lightmoni/mac-self-monitor/demo.env
set +a
go run ./examples/self-monitoring --traffic

# 正常订单 / 可控失败；每 10 次演示流量会产生 1 次失败。
curl -X POST http://127.0.0.1:18480/orders
curl -X POST 'http://127.0.0.1:18480/orders?fail=1'
```

业务退出时仅关闭自己的 SDK，Shutdown 截止时间为 5 秒；Agent 继续采集和补传。结束整个本机测试时，分别向业务、Agent 和中心进程发送 Ctrl-C；不要将 Agent 的启停绑定到业务进程。Linux 部署使用独立 systemd 服务，发布包自带 Node 24.15.0；这里展示的是 macOS 源码运行流程，不代表 Linux/systemd 或 Docker 镜像已验收。在线执行节点默认 90 秒无心跳离线（控制周期超过 30 秒时使用三倍周期）；在线 SDK 为 90 秒无新心跳离线。重新启动 LightMoni Agent 使用同一配置目录保留执行节点身份；业务重启会生成新的 SDK 进程实例身份。

内置大盘：

- [中心监控](http://localhost:18380/dashboards/system-center)：QPS、首次确认接收量、请求错误/耗时、队列、Node 堆内存、活跃资源、事件循环延迟和中心日志。
- [执行节点监控](http://localhost:18380/dashboards/system-agent)：在线数、积压、最老批次年龄、采集异常和执行日志。
- [SDK 监控](http://localhost:18380/dashboards/system-sdk)：在线实例、重试/丢弃/溢出、缓冲和内部诊断日志。

在对应图表的告警设置中，可以配置「在线数低于 1」等规则；内置在线总数查询在完全离线时返回 0，便于配置数量告警。示例验证规则仅在告警列表产生事件，没有绑定外部通知目标。
