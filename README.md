# LightMoni

面向个人和小团队的一体化监控工作台。Node.js / TypeScript 主服务提供 React + TypeScript 界面，SQLite 保存管理数据，ClickHouse 保存日志、指标和链路。LightMoni Agent 运行实例称为执行节点，采集主机、进程、拨测和目录日志，接收 Go、JavaScript/TypeScript、Python、PHP、Ruby、Rust SDK 数据并持久化缓存。

中心与 LightMoni Agent 均由 Node.js / TypeScript 实现，公共协议和存储工具位于 `runtime/src/shared`；业务 Go SDK 与其余五种语言 SDK 保留。迁移规格与验收见 [Node 运行时迁移](specs/007-node-runtime-migration/spec.md) 和 [领域验证](specs/007-node-runtime-migration/domain-validation.md)。

没有项目或租户概念。每份 Key 可配置逻辑 table 白名单，或显式允许所有 table，不绑定 service；服务通过 `service` 标识，业务通过逻辑 `table` 选择数据流。服务自动生成 `log_*`、`metric_*_sum/gauge/histogram`、`trace_*`，在记录中写入实际认证的 `key_id`。

## Docker Compose 部署

根目录的 [compose.yaml](compose.yaml) 默认只启动 LightMoni，连接已有 ClickHouse。主服务镜像内置网页、两种 Linux 架构的 LightMoni Agent 安装包和六种语言的 SDK，无需单独部署前端。最终镜像使用 `node:24.15.0-bookworm-slim`；Go 构建阶段只生成业务 Go SDK 下载包，中心和 Agent 的运行环境不包含 Go。

在仓库根目录准备配置：

```sh
cp .env.example .env
chmod 600 .env
```

编辑 `.env`，填写 `LIGHTMONI_CH_URL`、`LIGHTMONI_CH_USER` 和 `LIGHTMONI_CH_PASSWORD`。数据库地址使用 ClickHouse 的 HTTP(S) 接口；宿主机上的数据库可以使用 `http://host.docker.internal:8123`，远程数据库使用其域名或 IP，数据库监听地址应允许容器访问。该账号需支持建库、建表、创建视图、读写、创建只读查询用户和授权；服务启动时会初始化 `lightmoni` 数据库和 `lightmoni_reader` 查询账号。

配置 `LIGHTMONI_PORT` 和 `LIGHTMONI_EXTERNAL_URL` 后构建并启动：

```sh
docker compose config --quiet
docker compose up -d --build --wait
```

打开默认的 `http://localhost:8080` 创建管理员。使用 Nginx 时，把 `LIGHTMONI_EXTERNAL_URL` 设为浏览器访问的 HTTPS 域名；如只允许宿主机反向代理访问，设置 `LIGHTMONI_BIND_ADDRESS=127.0.0.1`。SDK / 执行节点的默认中心上报地址初始使用该工作台地址，也可在“管理后台 → 接入配置”保存多个内网、公网入口。兼容启动脚本 `sh deploy/server/start.sh` 使用同一套根目录配置。

如果需要同时启动 ClickHouse，使用独立目录 [deploy/with-clickhouse](deploy/with-clickhouse/README.md) 中的 Compose 和 `.env.example`：

```sh
cd deploy/with-clickhouse
cp .env.example .env
chmod 600 .env
# 编辑 .env，填写 LIGHTMONI_CH_PASSWORD，并按部署环境修改端口和域名。
docker compose up -d --build --wait
```

该版本等待 ClickHouse 就绪后启动主服务，数据库端口只在 Compose 网络内开放。根目录和该目录的 `.env` 各自使用，选择对应目录执行命令。

两种配置默认构建 `lightmoni:0.1.0`。使用已发布镜像时，将对应 `.env` 中的 `LIGHTMONI_IMAGE` 改为仓库地址与固定版本，再在对应目录运行：

```sh
docker compose pull lightmoni
docker compose up -d --no-build --wait
```

更新源码版本后重新运行 `docker compose up -d --build --wait`；查看日志使用 `docker compose logs -f --tail=100`，停止服务使用 `docker compose down`。SQLite、加密主密钥和队列保存在 `lightmoni-state` 卷，随附数据库使用独立的 `lightmoni-telemetry` 卷。备份和恢复时配套保存状态卷、ClickHouse 数据和 `.env`；普通更新保留数据卷。容器提供健康检查、退出宽限时间和日志轮转。

## LightMoni Agent、执行节点与 SDK

软件统一称 **LightMoni Agent**，部署在主机或容器中的运行实例称 **执行节点**；节点内部执行指标和日志采集的模块称采集器。导航入口为“节点助手”，网页对话能力仍称“AI 助手”。当前节点执行监控任务，不提供模型调用或通用命令执行能力。

LightMoni Agent 作为独立进程或容器运行，由自己的进程管理器或容器编排管理生命周期。业务 SDK 可直接上报平台（direct），也可明确选择经 Agent 上报（agent）；接入页默认 direct，安装 Agent 不是 SDK 直连的前置条件。同一节点可接收多个业务的数据，也可独立承担主机采集、拨测和目录日志，业务路由与这些节点任务互不绑定。业务启动、停止或重启不触发 Agent 启停。业务退出时完成 SDK flush/shutdown，Agent 继续采集和补传。CLI 支持 `run --config` 前台运行并响应 SIGTERM；当前网页安装命令覆盖 Linux systemd 服务。每个 Agent 实例使用独立、可持久化的数据目录，以保留身份与待补传队列。两条上报路径的配置与边界见 [SDK 接入](sdk/README.md#选择上报方式) 和 [SDD 012](specs/012-sdk-reporting-choice/spec.md)。

“数据接入”提供独立的“SDK 接入”和“执行节点接入”Tab。接入时选择初始任务标签、上报地址并填写 Key，复制生成的安装命令到 Linux 服务器执行。安装程序保存连接配置，无需编辑 JSON；所填 Key 用于安装脚本、LightMoni Agent 包及校验文件的下载鉴权和后续上报。新 Key 默认填入当前标签匹配的启用任务所需表，业务 SDK 使用的 table 需另行授权；标签没有启用任务时需手动填写业务 table，不自动扩大权限。安装包支持 Linux amd64 / arm64，自带固定 Node 24.15.0，要求 glibc ≥ 2.28，无需目标主机另装 Node/npm；验证 SHA256 后安装独立 systemd 服务，升级、重装保留身份和磁盘队列。

“节点助手”提供“执行节点 / 任务管理 / 任务标签”三个页签。任务独立保存，类型为指标采集、服务拨测和目录日志；每个任务可关联多个任务标签，一个节点也可绑定多个标签。启用任务与节点任一标签相交即下发，同一任务不会因多次命中而重复执行。冲突配置会整体拒绝并保留原有效配置；未匹配任务时暂停内部采集和拨测，业务数据转发继续可用。已有节点重连时保留中心分配。指标采集任务可选择 CPU、内存、文件系统、磁盘 I/O、网络、负载或指定进程，并设置采集间隔。

升级会将原分组迁移为同名任务标签和独立任务，保留节点身份、原参数及目标表；迁移完成后不再重建已删除任务。既有 `/agents` 页面地址、`--group-id` 安装参数和节点轮询协议继续兼容，安装参数表示初始任务标签，接入后可在中心绑定多个标签。

目录日志填写绝对目录、文件匹配规则（默认 `*.log*`）、是否包含子目录和首次从头读取。默认只采集现有文件后续新增的行，之后新建文件完整采集；读取进度与队列批次一起提交，支持重启续读、重命名轮转和截断检测。要求服务用户可读目录，采集 UTF-8 文本行，跳过压缩文件和符号链接；单行超过 64 KiB 分片，未结束的短行等待换行。事件时间使用采集时间，保留文件路径和字节位置。每个执行节点最多同时打开 256 个日志文件，每个目录单次扫描最多 10,000 个条目，超限会显示采集错误。源文件在采集前已删除或覆盖的内容无法恢复。

“SDK 接入”默认“直连平台”，也可选择“通过 LightMoni Agent”，六种语言均提供对应的代码高亮示例、环境变量和复制按钮。通过 Agent 默认连 `http://127.0.0.1:4318`，平台凭据由 Agent 保存；如节点开启本地令牌，SDK 使用 `LIGHTMONI_LOCAL_TOKEN`。直连平台无需部署执行节点，使用 `LIGHTMONI_ENDPOINT` 与允许目标 table 的 `LIGHTMONI_DATA_KEY`，适用于普通服务器、容器、Serverless 等部署；`LIGHTMONI_KEY` 仍作为兼容别名。六种 SDK 的 `from_env` / `fromEnv` / `NewFromEnv` 会读取所选模式的变量，也可继续使用显式构造函数。容器通过 environment / Secret 注入，平台或 Agent 地址应使用容器可访问的域名或服务地址。同一 Docker 网络访问平台可用 `http://lightmoni:8080`，Docker Desktop 访问宿主机可用 `host.docker.internal`。SDK 经 Agent 上报时，也受节点上游凭据的 table 白名单约束。

管理员可在“管理后台 → 接入配置”维护多个有名称的上报地址，并选择默认项，例如“公网”和“内网”。SDK 直连与执行节点接入均可从列表选择，也支持临时填写其他可访问地址；所选地址会进入复制的 SDK 示例、环境变量或 LightMoni Agent 安装命令。旧的单地址配置自动兼容；未配置列表时使用部署变量 `LIGHTMONI_EXTERNAL_URL`。这些地址应转发到同一个 LightMoni 实例。LightMoni Agent 安装脚本、amd64 / arm64 包和 SHA256 校验文件由当前项目内置的 `/downloads/agent/` 提供，全部要求 `Authorization: Bearer <上报 Key>`，无密钥、错误或禁用 Key 均不能下载。SDK 通过执行节点时默认使用本机节点地址。修改地址列表不改变已运行客户端的连接配置；重新生成安装命令可更新节点地址并保留身份和磁盘队列。此配置独立于登录回调和告警链接使用的工作台地址。

```ts
// 按接入页配置 LIGHTMONI_MODE 及所选路径的地址、凭据。
const moni = createLightMoniFromEnv({service: 'order-api', table: 'business'});
const orders = moni.counter('orders_created');
orders.add(1, {region: 'cn', payment: 'wechat'});
moni.log('info', 'order created', {order_id: '123'});
await moni.flush();
```

服务内的数据接入页提供六种 SDK 包，支持选择语言、安装命令、业务示例和下载校验。Node / 浏览器使用 npm 包，Go、Python、PHP、Ruby、Rust 使用可本地安装或源码引用的独立包。Go 包解压后，在业务模块通过 `go mod edit -replace github.com/lightmoni/lightmoni=./lightmoni-go-sdk` 引用，再执行 `go mod tidy`；源码中的 import 路径不要求先发布远程仓库。

所有语言的安装、API 和可靠性边界：[sdk/README.md](sdk/README.md)。Python、PHP、Ruby、Rust 使用显式 flush，由应用定时或在请求结束时调用；Go / TypeScript 保留周期 collection。可运行示例：[examples/sdk](examples/sdk)。浏览器通过业务后端转发埋点，业务后端持有仅允许目标 table 的 Key；示例提供本地转发服务器，页面无需保存 Key。

要在真实库中观察日志查询、服务/级别/属性聚合与指标，可运行本地业务流量程序：

```sh
node examples/sdk/traffic/index.mjs
```

程序在 `127.0.0.1:18419` 发起真实 HTTP 请求，通过 SDK 和本机执行节点上报三个测试服务，默认运行 30 分钟。可用 `LIGHTMONI_ENDPOINT`、`LIGHTMONI_DURATION_SECONDS` 调整接收地址和时间；本次运行的验收执行节点地址为 `http://127.0.0.1:14318`。这些记录用于测试，资源属性注明 `telemetry_source=sdk-traffic-fixture`。

## 工作台功能

- 多大盘、布局拖动缩放、多 SQL 面板、类型化变量、共享时间、自动刷新、图例与原始数据检查器；AntV 图表、真实目录生成的 SQL 样例与快捷模板。
- 日志探索、字段过滤、时间分布、详情与同源上下文、trace 关联、冻结分页、实时流、保存检索和导出。
- 图表按当前曲线设置阈值或没有打点告警，绑定人员责任组；支持固定/天/周排班、多主多备、P0～P3、接手与升级、静默窗口、日志现场、Trace树及接手率/时长统计。规则可继承数据表责任组，详见[告警响应与值班](docs/alert-response.md)。
- Webhook、飞书群/企业应用机器人、钉钉、企业微信、Pushplus 公众号推送；阿里云、腾讯云、华为云短信；阿里云、腾讯云电话语音；SMTP 邮件（QQ、163、126、腾讯企业邮、阿里企业邮预设及自定义服务器）。各渠道需填入自己的供应商配置，详见[通知渠道配置](docs/notification-channels.md)。
- 本地用户管理，以及微信网站登录、QQ 互联、GitHub、通用 OAuth2；提供 state、PKCE、稳定身份绑定、首次用户审核。
- Mastra 驱动的 AI 助手：流式回答、工具时间线和中止；读取目录、生成 SQL、分析日志，预览并确认保存大盘。较早对话按完整轮次整理摘要，显示模型报告的用量；管理员可自动获取模型目录，配置 OpenAI Chat Completions、Responses、Anthropic Messages 或 Gemini 协议及输入、输出和执行步数限制。

应用控件使用 React 组件，不调用浏览器原生选择框、确认框或输入对话框。所有成员共享实例数据；管理员管理用户、凭证和供应商密钥。

## 本地开发和验收

本地构建建议使用 Node 24.15.0（运行时最低 Node 22.19），并准备可访问的真实 ClickHouse。仅开发 Go 业务 SDK、运行 Go 业务示例或打包六种 SDK 时需要 Go 1.26+。Docker Compose 用于容器部署，可在有 Docker 的环境启动隔离测试数据库：

```sh
docker compose -p lightmoni-test -f deploy/server/compose.test.yml up -d
```

在仓库根目录依次构建：

```sh
npm run setup
npm run build
LIGHTMONI_DATA=.local-dev/node-dev/state LIGHTMONI_ADDR=127.0.0.1:18880 LIGHTMONI_EXTERNAL_URL=http://127.0.0.1:18880 npm start
```

根脚本按 TypeScript SDK → runtime → ai-runtime → web 的依赖顺序安装和构建，对应各目录的 `npm ci` / `npm run build`。中心的直接启动入口是 `node runtime/dist/server/main.js`。

中心实现位于 `runtime/src/server`，大盘/日志/告警位于 `runtime/src/domains`，AI 会话与工具位于 `runtime/src/assistant`，公共类型及存储工具位于 `runtime/src/shared`；执行节点位于 `runtime/src/agent`。网页构建输出到 `runtime/public`。数据库连接和状态目录继续使用 `LIGHTMONI_CH_URL` / `LIGHTMONI_CH_USER` / `LIGHTMONI_CH_PASSWORD` / `LIGHTMONI_DATA`。

需要测试下载与安装时，单独生成发布包（默认输出 `runtime/downloads`）：

```sh
npm run release:agent -- 0.1.0
npm run release:sdk -- 0.1.0
```

Agent 发布脚本下载并校验 Linux 双架构的固定 Node 发行包；打包成功不代表已在相应 Linux 主机运行验收。Agent 独立启动命令为 `node runtime/dist/agent/main.js run --config /path/agent-config.json`，生命周期和业务应用分开管理，详见 [执行节点接入](examples/agent/README.md)。

另一个终端运行开发界面：

```sh
cd web
LIGHTMONI_DEV_API_URL=http://127.0.0.1:18880 npm run dev
```

`scripts/demo-smoke.py` 用隔离开发实例创建测试管理员、允许 `http`/`app` 的 Key，运行 Go/Node demo，核对多服务计数、日志与 span 关联。默认地址 `127.0.0.1:18880`，默认测试用户名 `local-admin` / 密码 `local-demo-password`；只用于该测试工作流。主服务未初始化时脚本会初始化。

```sh
npm run typecheck
npm test
npm run build
```

真实 ClickHouse 联调用隔离中心和测试账号，显式提供地址后运行；不应将 fixture 测试指向生产实例：

```sh
cd runtime
LIGHTMONI_DOMAINS_URL=http://127.0.0.1:18885 node --import tsx --test test/domains-live.test.ts test/agent-live.test.ts
```

可通过 `LIGHTMONI_DOMAINS_USER` / `LIGHTMONI_DOMAINS_PASSWORD` 指定隔离测试账号。域联调覆盖真实 OTLP 入库、日志、Trace、大盘、SQL 告警和本地 Webhook；节点联调覆盖 SDK → Agent 磁盘队列 → 中心和重启补传。Go SDK 单独使用 `go test -race ./sdk/go`；多语言工具链和 Docker 齐备时可运行 `python3 scripts/test-sdks.py --docker`。`python3 scripts/demo-smoke.py` 是业务示例的补充检查。

本次迁移的本机环境为 macOS，已运行真实 ClickHouse 和 Node 联调；没有 Docker，未执行 Docker 镜像构建或 Linux systemd 实机验收。具体证据及边界见 [迁移验收](specs/007-node-runtime-migration/quickstart.md) 和 [领域验证记录](specs/007-node-runtime-migration/domain-validation.md)。

开发模式测试 ClickHouse 只绑定 `127.0.0.1:18123`，使用固定测试密码；发版配置需要在 `.env` 中明确填写数据库密码。默认数据目录 `.lightmoni`、示例隔离目录 `.local-dev`、各目录的 `.env` 和构建产物不纳入源码。

## AI 助手运行时

Node 主服务为每轮对话启动一个 Mastra Node worker，使用私有 stdin/stdout 管道通信，无需额外端口。模型调用与多步决策由 Mastra 执行，表目录、SQL 和草稿工具仍由中心 TypeScript 模块在当前登录用户上下文中执行。会话、事件、摘要和模型配置使用主服务 SQLite；API Key 加密保存，仅通过私有管道传入 worker，不进入浏览器响应或进程参数。Compose 镜像内包含 Node、锁定依赖和编译好的 worker。

本地从仓库根启动，先执行 `npm --prefix ai-runtime ci && npm --prefix ai-runtime run build`。默认通过 PATH 中的 `node` 运行 `ai-runtime/dist/runner.js`；可用 `LIGHTMONI_AI_NODE` 指定 Node 可执行文件，用 `LIGHTMONI_AI_RUNNER` 指定编译后的入口绝对路径。缺少运行时会在对话中明确报错，其他监控服务保持可用。

在 AI 助手的模型连接设置中填写服务地址和 Key，系统会自动获取可选模型，也可点击「获取模型」重试或手动填写模型名称。支持 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 和 Google Gemini 四种协议，分别使用原生 SDK 接入 Mastra；旧配置缺少协议时默认 Chat Completions。「自动识别」依据官方地址、完整接口路径和目录格式给出建议；第三方 OpenAI 兼容目录不能区分 Chat 与 Responses 时，须选择具体协议再保存。模型名称不能用于推断协议，获取列表也不能证明生成、工具调用能力或上下文容量。

支持 API 基地址、根地址，以及完整 `/chat/completions`、`/responses`、`/messages` 或 Gemini 生成接口地址。使用新填写的 Key 或无需 Key 时，根地址按协议优先尝试 `/v1`；Gemini 可回退到 `/v1beta`，最后尝试无版本目录。OpenAI/Anthropic 的独立末段 `/v1beta` 会修正为 `/v1`；Gemini 明确填写的版本和自定义路径保留。各协议的版本修正、目录鉴权及查询参数集中维护，获取模型、测试连接和保存共用地址规范化；修正后在输入框回填并显示原因。已保存 Key 只可在原规范 API 基地址复用，改地址须重新填写或明确清除；同地址切换协议可保留 Key。目录查询不会保存配置或发起生成请求，401 表示供应商未接受凭证。

默认输入预算 32,000、单次模型输出上限 4,096、每轮 8 步（最多 12 步），整轮仍限制 2 分钟，每个实例最多并行执行 4 轮，达到上限时明确提示稍后重试。输入预算使用保守的 UTF-8 字节估算并在每次模型调用前检查；它不是精确的 tokenizer 计数，应设在模型实际上下文容量以内并预留输出空间。历史整理会产生额外的模型请求和用量，只有供应商实际返回的计数才作为已知用量展示。管理员在“模型管理”中设置每百万 token 的输入、输出单价及币种，查看 7/30/90 天的 token 和估算费用；助手、历史整理、连接测试及 Pi 代码任务均计入，未知用量/单价分别标明，修改价格不重算历史费用。Responses 使用 `store:false`；多轮所需的加密推理状态和 Gemini 签名仅在服务端有界保存、通过私有管道重放，不返回浏览器，也不保存隐藏推理明文。

模型管理记录每个实际发出请求的成功、失败、取消或进行中状态；服务重启会将遗留进行中请求标为中断失败，未报告的 token 保持未知。调用明细保留当时输入/输出单价和分项费用，仅有一侧可计价时显示已知部分。同一连接保存执行限制会保留单价草稿，更换连接或重新加载前提示确认。统计刷新保留分组和有效页码，默认最近日期优先，显示最后刷新时间。

自动识别取得唯一协议建议后可直接测试连接，目录有歧义时需手选协议。测试会发送真实请求，并在 SDK 序列化后限制总输出预算最多 256 token；所选思考配置无法容纳时在发送前明确拒绝。供应商已响应但输出预算耗尽会单独提示，相关请求仍计入用量。

摘要保留历史事实、用户要求和工具证据，原始记录仍保留。无法在预算内整理的单个历史轮次或超大的当前上下文会返回明确错误，需缩小查询或增大预算；源历史不被删除。停止、浏览器断开和超时会取消当前 worker 与中心工具。完成的检查点可重载，但进程中断后不会自动恢复执行。本轮不包含后台定时排查、自动修复或额外审阅模型。

可选代码能力采用 **Mastra 编排 + Pi Agent 任务内多轮执行**。运维显式配置 `LIGHTMONI_CODE_WORKSPACE=/srv/lightmoni-code-workspaces` 后，管理员可在 AI 助手中选择相对工作区，要求编写或修改轻量脚本。Pi 在临时副本读写，返回步骤、检查结果和 diff；管理员点击确认应用后才写回，原文件有变动则拒绝应用。不会自动提交、推送、合入或部署。预览 30 分钟有效，源码记录加密保存。

检查命令默认关闭，运维可配置 `LIGHTMONI_CODE_CHECK_COMMANDS='["node --check app.js"]'`。副本不安装依赖、不复制 node_modules；只支持已具备运行条件的检查。命令以中心服务身份运行，临时副本不是操作系统沙箱，应仅授权专用可信源码目录和检查命令。容器部署需显式挂载工作区并传入环境变量，默认 Compose 不挂载主机源码。

SDD 规格和验收入口：[Mastra 助手](specs/001-mastra-assistant/spec.md)、[模型发现](specs/002-model-discovery/spec.md)、[多协议连接](specs/003-multi-protocol-models/spec.md)、[模型管理与计费](specs/005-model-management/spec.md)、[Node 运行时迁移](specs/007-node-runtime-migration/spec.md)、[Mastra + Pi 代码任务](specs/008-mastra-pi-agent-code-tasks/spec.md)。使用仓库内 Spec Kit 技能继续维护规格、计划与任务。检查运行时使用 `npm --prefix ai-runtime test`、`npm --prefix ai-runtime run typecheck` 和 `npm --prefix runtime test`；构建 worker 后，Node 集成测试会通过真实 Mastra SDK 连接隔离模型 fixture。fixture 不代表真实供应商分析效果验收。

## Key 的 table 权限

管理员在“数据接入 → 上报 Key”创建、编辑上报范围：可选择“指定 table”并设置逻辑表白名单，也可选择“所有 table”，允许写入现有及未来的新 table。执行节点接入页创建 Key 时同样支持这两种范围；默认使用指定 table。白名单支持多选已有表，也可填写尚未上报的新逻辑表名，不使用通配符。`web` 对应 `log_web`、`metric_web_*`、`trace_web`，白名单匹配 SDK 的 `table` / `X-Lightmoni-Table`，不填写 SQL 表名前缀。权限对日志、指标、链路都生效，越权请求返回 403，不自动建表或写入数据。修改上报范围立即影响后续请求和批次重试。

升级已有实例时，旧 Key 的白名单为空，数据写入会被拒绝。管理员需先编辑这些 Key 的上报范围（指定 table 或所有 table）；执行节点使用指定模式时需包含其匹配任务设置的机器指标、拨测、目录日志表（默认 `host`、`probe`、`files`）和实际业务 table。配置权限不更换原 Key。

## 数据与可靠性边界

自有 SDK 批次在冻结后保持内容和 ID 不变。执行节点在 SQLite WAL 持久化后 ACK，主服务在 ClickHouse 写入及批次确认后 ACK。内部 ReplacingMergeTree 配合公共 `FINAL` 视图去重，避免丢 ACK 重试造成计数翻倍。普通 OTLP 未提供稳定批次 ID 时遵循至少一次交付。SDK 缓存有界且只在进程内；执行节点磁盘队列有容量、重放时间和保留期限制，不承诺无限离线缓存。

只读 SQL 通过 AST 校验和独立查询账号；禁止私有表、跨库、外部表函数和自行设置资源限额。默认每次最多 8 个查询、10 秒执行、10,000 行展示。时间范围为 `[from,to)`，`UInt64` / `Int64` / Decimal 结果保留字符串。指标 `value_float` 保存原始浮点，`value_int` 保存精确整数，公开 `value` 为浮点；整数汇总使用 `sum(toDecimal256(value_int,0))`；图表超出安全精度时要求明确选择近似展示。日志/链路默认保留 7 天，指标 30 天。

详细方案：[docs/architecture.md](docs/architecture.md)、[docs/contracts.md](docs/contracts.md)。验收证据和未验收项：[docs/acceptance.md](docs/acceptance.md)。没有真实账号凭证的第三方登录、通知和 AI 供应商只能标注协议测试，不能视为真实供应商验收。Grafana / Kibana 核心交互以任务矩阵逐项验证；不作未经对比测试的性能或完整功能等同承诺。

### 系统自监控

初始化会建立 `lightmoni_center`、`lightmoni_agent`、`lightmoni_sdk` 三类内置逻辑表，并创建「系统监控 · 上报中心 / 执行节点 / SDK」大盘。系统表通过标准查询、日志浏览和图表告警使用；首次初始化之后保留大盘编辑，也不会在重启时重新创建用户主动删除的大盘。Node 迁移仅将未编辑的旧 Go 运行指标面板一次性更新为活跃资源和事件循环延迟，并保留版本记录。

中心记录上报接口 QPS / 响应状态 / 耗时、首次成功确认的记录数与 OTLP 字节数、Node 堆内存、活跃资源、事件循环延迟和自监控队列；重复批次只增加接口请求次数，不重复计算接收量。执行节点控制心跳转换成在线状态、队列和采集诊断；启动、配置变更与执行失败日志在中心 SQLite 暂存，写入 ClickHouse 成功后清除。SDK 自监控在原有业务权限验证后自动分流到系统 SDK 表。见 [SDK 内部监控](sdk/README.md#内部监控) 和 [本机封装 SDK 示例](examples/self-monitoring/README.md)。
