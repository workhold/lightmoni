# LightMoni

面向个人和小团队的一体化监控工作台。Go 主服务内嵌 React + TypeScript 界面，SQLite 保存管理数据，ClickHouse 保存日志、指标和链路。Go Agent 采集主机、进程、拨测和目录日志，接收 Go、JavaScript/TypeScript、Python、Java/Kotlin JVM、C#/.NET、PHP、Ruby、Rust SDK 数据并持久化缓存。

没有项目或租户概念。每份 Key 可配置逻辑 table 白名单，或显式允许所有 table，不绑定 service；服务通过 `service` 标识，业务通过逻辑 `table` 选择数据流。服务自动生成 `log_*`、`metric_*_sum/gauge/histogram`、`trace_*`，在记录中写入实际认证的 `key_id`。

## 一键部署

需要 Docker Compose 和 OpenSSL。在仓库根目录运行：

```sh
sh deploy/server/start.sh
```

脚本首次生成权限为 0600 的 `.env` 和随机数据库密码，随后构建并启动主服务、ClickHouse 两个容器。打开 `http://localhost:8080` 创建管理员。更换端口及公开服务地址可在首次运行前设置：

```sh
LIGHTMONI_PORT=18880 LIGHTMONI_EXTERNAL_URL=http://your-server:18880 sh deploy/server/start.sh
```

已有部署修改 `.env` 后重新运行。SQLite、加密主密钥与 ClickHouse 使用独立持久卷。ClickHouse 不向宿主机公开端口。主服务反向代理时，将 `LIGHTMONI_EXTERNAL_URL` 设为用户和 Agent 均可访问的完整地址；第三方登录回调使用该地址。

## Agent 与 SDK

“数据接入”提供独立的“SDK 接入”和“Agent 接入”Tab。在“Agent 接入”选择 Agent 分组、填写上报地址和 Key，复制生成的命令到 Linux 服务器执行，在隐藏输入提示中粘贴 Key（页面支持单独复制 Key）。安装程序自动保存连接配置，无需编辑 JSON。创建 Key 时默认授权所选组的机器指标、拨测和目录日志表，也可授权所有 table；业务 SDK 使用的 table 需另行授权。安装包支持 amd64 / arm64，验证 SHA256，安装 systemd 服务；升级、重装保留身份和磁盘队列。

在“Agent → 配置分组任务”通过四个 Tab 设置机器指标、HTTP/TCP 拨测、目录日志和上报表。同组所有 Agent 使用同一份任务，平台支持更改机器所属分组；已有机器重连时保留平台分配。机器指标可关闭，也可勾选 CPU、内存、文件系统、磁盘 I/O、网络、负载或指定进程，并设置采集间隔。

目录日志填写绝对目录、文件匹配规则（默认 `*.log*`）、是否包含子目录和首次从头读取。默认只采集现有文件后续新增的行，之后新建文件完整采集；读取进度与队列批次一起提交，支持重启续读、重命名轮转和截断检测。要求服务用户可读目录，采集 UTF-8 文本行，跳过压缩文件和符号链接；单行超过 64 KiB 分片，未结束的短行等待换行。事件时间使用采集时间，保留文件路径和字节位置。每个 Agent 最多同时打开 256 个日志文件，每个目录单次扫描最多 10,000 个条目，超限会显示采集错误。源文件在采集前已删除或覆盖的内容无法恢复。

SDK 默认连本机 Agent `http://127.0.0.1:4318`，多个服务共用 Agent，不必分别申请 Key。直连主服务时传入允许写入目标 table 的有效 Key。SDK 通过 Agent 上报时，也受 Agent Key 的 table 白名单约束。

```ts
const moni = createLightMoni({
  service: 'order-api', table: 'business',
  endpoint: 'http://127.0.0.1:4318'
});
const orders = moni.counter('orders_created');
orders.add(1, {region: 'cn', payment: 'wechat'});
moni.log('info', 'order created', {order_id: '123'});
await moni.flush();
```

服务内的数据接入页提供八种 SDK 包，支持选择语言、安装命令、业务示例和下载校验。Node / 浏览器使用 npm 包，Go、Python、Java/Kotlin JVM、C#/.NET、PHP、Ruby、Rust 使用可本地安装或源码引用的独立包。Go 包解压后，在业务模块通过 `go mod edit -replace github.com/lightmoni/lightmoni=./lightmoni-go-sdk` 引用，再执行 `go mod tidy`；源码中的 import 路径不要求先发布远程仓库。

所有语言的安装、API 和可靠性边界：[sdk/README.md](sdk/README.md)。Python、Java、.NET、PHP、Ruby、Rust 使用显式 flush，由应用定时或在请求结束时调用；Go / TypeScript 保留周期 collection。可运行示例：[examples/sdk](examples/sdk)。浏览器通过业务后端转发埋点，业务后端持有仅允许目标 table 的 Key；示例提供本地转发服务器，页面无需保存 Key。

要在真实库中观察日志查询、服务/级别/属性聚合与指标，可运行本地业务流量程序：

```sh
node examples/sdk/traffic/index.mjs
```

程序在 `127.0.0.1:18419` 发起真实 HTTP 请求，通过 SDK 和本机 Agent 上报三个测试服务，默认运行 30 分钟。可用 `LIGHTMONI_ENDPOINT`、`LIGHTMONI_DURATION_SECONDS` 调整接收地址和时间；本次运行的验收 Agent 地址为 `http://127.0.0.1:14318`。这些记录用于测试，资源属性注明 `telemetry_source=sdk-traffic-fixture`。

## 工作台功能

- 多大盘、布局拖动缩放、多 SQL 面板、类型化变量、共享时间、自动刷新、图例与原始数据检查器；AntV 图表、真实目录生成的 SQL 样例与快捷模板。
- 日志探索、字段过滤、时间分布、详情与同源上下文、trace 关联、冻结分页、实时流、保存检索和导出。
- 图表直接按当前曲线设置高于、低于阈值或没有打点告警，并绑定接收通知的告警组；未指定通知组的独立规则继承数据表设置。支持触发、恢复、无数据、错误、静默、重试和发送历史。
- Webhook、飞书、钉钉、企业微信、Pushplus 公众号推送、SMTP 邮件、阿里云短信。各渠道需填入自己的供应商配置。
- 本地用户管理，以及微信网站登录、QQ 互联、GitHub、通用 OAuth2；提供 state、PKCE、稳定身份绑定、首次用户审核。
- Doca 骨架的 AI 会话、流式消息、工具时间线和中止；读取目录、生成 SQL、分析日志，预览并确认保存大盘。管理员在 AI 设置中配置兼容 Chat Completions 的模型供应商。

应用控件使用 React 组件，不调用浏览器原生选择框、确认框或输入对话框。所有成员共享实例数据；管理员管理用户、凭证和供应商密钥。

## 本地开发和验收

Go 1.26+、Node 24+、Docker Compose。在仓库根运行：

```sh
docker compose -p lightmoni-test -f deploy/server/compose.test.yml up -d
npm --prefix web ci
npm --prefix sdk/typescript ci
npm --prefix sdk/typescript run build
npm --prefix web run build
sh deploy/agent/release.sh 0.1.0 internal/server/agent-dist
sh scripts/build-sdk-release.sh 0.1.0 internal/server/agent-dist
LIGHTMONI_ADDR=127.0.0.1:18880 LIGHTMONI_EXTERNAL_URL=http://localhost:18880 go run ./cmd/lightmoni
```

另一个终端运行开发界面：

```sh
cd web
LIGHTMONI_DEV_API_URL=http://127.0.0.1:18880 npm run dev
```

`scripts/demo-smoke.py` 用隔离开发实例创建测试管理员、允许 `http`/`app` 的 Key，运行 Go/Node demo，核对多服务计数、日志与 span 关联。默认地址 `127.0.0.1:18880`，默认测试用户名 `local-admin` / 密码 `local-demo-password`；只用于该测试工作流。主服务未初始化时脚本会初始化。

```sh
python3 scripts/demo-smoke.py
go test -race ./...
npm --prefix sdk/typescript test
python3 scripts/test-sdks.py --docker
LIGHTMONI_NATIVE_SDK_TEST=1 go test -race ./sdk/go -run TestNativeSDKsDurablyAcceptedByActualAgent
npm --prefix web run typecheck
npm --prefix web run build
```

开发模式测试 ClickHouse 只绑定 `127.0.0.1:18123`，使用固定测试密码；生产启动脚本使用随机密码。数据目录 `.lightmoni`、`.env` 和构建产物不纳入源码。

## Key 的 table 权限

管理员在“数据接入 → 上报 Key”创建、编辑上报范围：可选择“指定 table”并设置逻辑表白名单，也可选择“所有 table”，允许写入现有及未来的新 table。Agent 接入页创建 Key 时同样支持这两种范围；默认使用指定 table。白名单支持多选已有表，也可填写尚未上报的新逻辑表名，不使用通配符。`web` 对应 `log_web`、`metric_web_*`、`trace_web`，白名单匹配 SDK 的 `table` / `X-Lightmoni-Table`，不填写 SQL 表名前缀。权限对日志、指标、链路都生效，越权请求返回 403，不自动建表或写入数据。修改上报范围立即影响后续请求和批次重试。

升级已有实例时，旧 Key 的白名单为空，数据写入会被拒绝。管理员需先编辑这些 Key 的上报范围（指定 table 或所有 table）；Agent 使用指定模式时需包含其分组设置的机器指标、拨测、目录日志表（默认 `host`、`probe`、`files`）和实际业务 table。配置权限不更换原 Key。

## 数据与可靠性边界

自有 SDK 批次在冻结后保持内容和 ID 不变。Agent 在 SQLite WAL 持久化后 ACK，主服务在 ClickHouse 写入及批次确认后 ACK。内部 ReplacingMergeTree 配合公共 `FINAL` 视图去重，避免丢 ACK 重试造成计数翻倍。普通 OTLP 未提供稳定批次 ID 时遵循至少一次交付。SDK 缓存有界且只在进程内；Agent 磁盘队列有容量、重放时间和保留期限制，不承诺无限离线缓存。

只读 SQL 通过 AST 校验和独立查询账号；禁止私有表、跨库、外部表函数和自行设置资源限额。默认每次最多 8 个查询、10 秒执行、10,000 行展示。时间范围为 `[from,to)`，`UInt64` / `Int64` / Decimal 结果保留字符串。指标 `value_float` 保存原始浮点，`value_int` 保存精确整数，公开 `value` 为浮点；整数汇总使用 `sum(toDecimal256(value_int,0))`；图表超出安全精度时要求明确选择近似展示。日志/链路默认保留 7 天，指标 30 天。

详细方案：[docs/architecture.md](docs/architecture.md)、[docs/contracts.md](docs/contracts.md)。验收证据和未验收项：[docs/acceptance.md](docs/acceptance.md)。没有真实账号凭证的第三方登录、通知和 AI 供应商只能标注协议测试，不能视为真实供应商验收。Grafana / Kibana 核心交互以任务矩阵逐项验证；不作未经对比测试的性能或完整功能等同承诺。
