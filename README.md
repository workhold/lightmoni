# LightMoni

[GitHub 仓库](https://github.com/workhold/lightmoni) · [问题反馈](https://github.com/workhold/lightmoni/issues) · [贡献指南](CONTRIBUTING.md) · [安全反馈](SECURITY.md)

面向个人和小团队的一体化监控工作台。Node.js / TypeScript主服务提供React界面，SQLite保存管理数据，ClickHouse保存遥测。业务接入提供多语言 record SDK；当前发布与 deferred 矩阵以 `/api/v1/sdk-install`、发布脚本和 [SDD 012](specs/012-sdk-reporting-choice/spec.md) 为准，业务SDK仅直连中心，SDK与Agent各自支持中心内网优先、公网备用。

> **完整系统设计入口**：[LightMoni 系统设计基线](docs/system-design.md)
>
> 该文档按 SDD 方式维护，集中说明驱动目标、HLD、LLD、数据流、协议、凭据安全、部署、AI/Agent 联动、当前限制和演进路线。本文 README 保留部署和快速上手，系统级设计以该基线及其关联 SDD 为准。

外部 Codex/Claude 与平台 AI 共用能力的架构见 [平台开放能力与 MCP](docs/platform-mcp.md)。首批主机/任务查询与操作提案、独立令牌、OAuth 授权和接入管理已实现，使用方法及当前边界见 [MCP 接入指南](docs/mcp.md)。

中心与LightMoni Agent均由Node.js / TypeScript实现，公共协议位于`runtime/src/shared`。SDK和中心上报采用本地通用打点与固定窗口方案，主机管理、SSH终端、Agent注册和control/data凭据、AI助手、告警与界面语言采用最新main；本次取舍见[整合说明](specs/011-aligned-metric-windows/main-integration.md)。

任务中心支持上传或编写脚本、选择主机及日历执行计划；用法与执行边界见 [脚本任务创建与调度](docs/task-authoring.md)，默认任务设计见 [SDD 049](specs/049-platform-default-tasks/spec.md)。

没有项目或租户概念。SDK有效启用密钥可写任意业务表，按名称创建，不绑定service或table。缺失Authorization只允许启用的豁免表，无效密钥不降级。初始化填写service/env，`record(table,metric_name,dimensions,value,count)`按调用选择业务表和指标，key1…key16为固定维度槽。每表单选10秒、30秒（默认）、1分钟、5分钟、10分钟、30分钟、1小时，查询步长须为实际窗口的整数倍。

## Docker Compose 部署

根目录 [compose.yaml](compose.yaml) 同时运行 LightMoni 和 ClickHouse。中心镜像直接指定为 `docker.heyphp.com/lightmoni/lightmoni:20261031-8386b5b`，支持 Linux amd64/arm64，内置网页、双架构 Agent 和四种 record SDK。镜像版本由仓库维护，无需在 `.env` 指定；旧 `LIGHTMONI_IMAGE` 值不再覆盖它。中心以非 root 用户运行。

首次获取源码：

```sh
git clone https://github.com/workhold/lightmoni.git
cd lightmoni
```

现有预构建镜像仍由 `docker.heyphp.com` 提供，需要该注册表的访问权限；GitHub 源码公开不代表已提供公开镜像。没有镜像仓库权限时，可在完成 `.env` 配置后按下文的源码构建步骤运行。已有部署继续沿用原项目名、数据库配置和数据卷。

```sh
cp .env.example .env
chmod 600 .env
# 编辑 .env，填写 LIGHTMONI_CH_PASSWORD，按需修改端口和域名。
docker compose config --quiet
docker compose pull
```

完整示例见 [根目录 `.env.example`](.env.example)；兼容部署目录也提供 [`.env.example`](deploy/with-clickhouse/.env.example)。启动相关配置如下：

| 配置项 | 默认值 | 用途 |
| --- | --- | --- |
| `COMPOSE_PROJECT_NAME` | `lightmoni` | 项目名；已有实例沿用原值以匹配数据卷 |
| `LIGHTMONI_BIND_ADDRESS` | `0.0.0.0` | 宿主机监听地址；仅本机反向代理访问可设为 `127.0.0.1` |
| `LIGHTMONI_PORT` | `8080` | 宿主机 HTTP 端口，映射到容器固定端口 8080 |
| `LIGHTMONI_EXTERNAL_URL` | `http://localhost:8080` | 用户实际访问地址，用于默认上报地址、登录回调和通知链接 |
| `LIGHTMONI_CH_URL` | `http://clickhouse:8123` | 数据库容器的 HTTP 地址，通常保持默认 |
| `LIGHTMONI_CH_USER` | `lightmoni` | 中心与数据库共用账号 |
| `LIGHTMONI_CH_PASSWORD` | 必填 | 数据库密码，可用 `openssl rand -hex 24` 生成 |
| `CLICKHOUSE_IMAGE` | `clickhouse/clickhouse-server:26.8` | 数据库镜像 |

例如将宿主端口改为 18080，在 `.env` 中同时修改：

```dotenv
LIGHTMONI_BIND_ADDRESS=0.0.0.0
LIGHTMONI_PORT=18080
LIGHTMONI_EXTERNAL_URL=http://localhost:18080
```

远程访问时将 URL 中的 `localhost` 换成服务器 IP 或域名；经过 HTTPS 反向代理时填写浏览器使用的 HTTPS 域名。修改 `.env` 后执行 `docker compose up -d --no-build --wait` 使配置生效。

Compose 已设置好容器内地址 `http://clickhouse:8123`。中心的 `LIGHTMONI_CH_URL`、`LIGHTMONI_CH_USER`、`LIGHTMONI_CH_PASSWORD` 由环境变量注入；ClickHouse 使用同一用户名和密码，允许中心建库、建表、创建只读查询用户和授权。数据库不暴露宿主机端口，中心等待数据库健康后启动。

系统没有默认管理员或默认密码。首次启动前可通过命令创建：

```sh
docker compose run --rm --no-deps --entrypoint lightmoni-admin lightmoni init --name admin
docker compose up -d --no-build --wait
```

密码按无回显提示输入两次，至少 8 个字符且最多 72 个 UTF-8 字节。也可先启动服务，再在首次访问 `http://localhost:8080` 时创建管理员；初始化只允许空用户库。

忘记管理员密码时执行：

```sh
docker compose exec lightmoni lightmoni-admin reset-password --name admin
```

重置只修改指定管理员密码并撤销该用户旧登录会话，保留账号角色和启用状态。中心停止时可用 `docker compose run --rm --no-deps --entrypoint lightmoni-admin lightmoni reset-password --name admin`。自动化标准输入及源码运行用法见 [管理员操作](deploy/server/README.md#管理员初始化与密码恢复)。

使用 Nginx 时，将 `LIGHTMONI_EXTERNAL_URL` 设为浏览器访问的 HTTPS 域名；如只允许宿主机反向代理访问，设置 `LIGHTMONI_BIND_ADDRESS=127.0.0.1`。SDK/节点默认上报地址初始使用工作台地址，也可在“管理后台 → 接入配置”保存多个入口。`sh deploy/server/start.sh` 使用根配置拉取并启动。原 [deploy/with-clickhouse](deploy/with-clickhouse/README.md) 入口继续兼容，两个服务统一继承根配置；沿用原项目名、`.env` 和卷名。

更新时先执行 `git pull --ff-only origin main`，获取仓库维护的镜像版本，再执行 `docker compose pull lightmoni` 和 `docker compose up -d --no-build --wait`，无需修改 `.env` 的镜像设置。仓库也提供 `latest`；根 Compose 使用固定发布标签。数据库密码、端口和项目名仍通过 `.env` 配置。发布仓库需要鉴权时先执行 `docker login docker.heyphp.com`；指定历史版本的回滚方法见 [Docker 更新与回滚](deploy/server/README.md#回滚与已有临时配置迁移)。源码构建则填写 `LIGHTMONI_BUILD_REVISION` 为 `git rev-parse HEAD` 的结果，并显式执行：

```sh
docker compose build lightmoni
docker compose up -d --no-build --pull never --wait
```

构建源参数仍支持 `LIGHTMONI_NPM_REGISTRY`、`LIGHTMONI_NODE_DIST_URL`、`LIGHTMONI_DEBIAN_MIRROR` 和 `LIGHTMONI_DEBIAN_SECURITY_MIRROR`，默认使用官方源，继续核对 npm integrity、Node 官方 SHA256 和 Debian 仓库签名。地址只填写无凭据公开源。

`lightmoni-state` 卷保存 SQLite、加密主密钥和队列，`lightmoni-telemetry` 卷保存 ClickHouse 数据。普通更新与 `docker compose down` 保留卷；备份和恢复时配套保存两个卷及受限 `.env`。查看日志使用 `docker compose logs -f --tail=100`。更多步骤见 [Docker 更新与回滚](deploy/server/README.md)。

管理员可在“主机管理 → 登录终端”打开交互式 SSH 小窗，连接前保存有效登录密码或 SSH 私钥；主机公钥与指纹首次连接自动记录、后续自动核验，见 [网页 SSH 终端](docs/machine-terminal.md)。

## 网站、容器、备份与计划任务

管理员从“运维工具”（`/operations`）管理小型静态网站、反向代理、HTTPS 证书、受管 Compose、目录备份和计划任务。先登记主机、部署 Agent 并配置运维资源，生成方案并人工批准，再查看真实执行回执；保存配置不会自动执行。AI 助手可以读取资源和创建方案，批准仍由管理员完成。

目标是受信 Linux 主机：网站按需安装 Nginx/OpenSSL，ACME 另需 Certbot，容器需 Docker 与 Compose plugin；执行节点不持有模型 Key。网站使用独立受管网关，不自动接管现有 Nginx/1Panel 或 80/443。Compose 接受受限 JSON 文档，配置回退保留卷数据。备份只覆盖 root 管理的普通文件目录，不承诺活动数据库一致性。详细步骤、依赖和验证边界见 [运维使用说明](docs/operations.md)、[HLD/LLD](docs/system-design.md#26-运维平台网站容器备份与计划任务sdd-026) 与 [SDD 026](specs/026-operations-platform/spec.md)。

## LightMoni Agent、执行节点与 SDK

软件统一称 **LightMoni Agent**，是登记主机上的管理通道；内部采集指标和日志的模块称采集器，网页对话能力称“AI 助手”。用户从“主机管理”统一查看主机资产、Agent 通道、任务中心与主机标签。Agent 执行内置采集、拨测、日志任务，以及管理员审阅授权的运维任务和有限脚本，不持有模型 Key。

接入只有一条路径：**登记主机与 SSH 登录信息 → SSH 预检（自动记录主机公钥、发现网卡地址） → 审阅确认 → 平台部署 Agent**。登记弹窗同屏填写名称、SSH 连接地址、端口、用户名、登录密码或 SSH 私钥及保存时长，默认密码登录、保存 6 小时；也可只登记主机、稍后补充凭据。SSH 连接地址首次由用户提供，平台不会从私钥或浏览器所在电脑猜测远端地址。主机 ID 由平台生成、不可修改。主机公钥与指纹无需填写或确认，首次 SSH 握手自动记录，在详情只读展示，后续连接自动比对；指纹、主机 ID 和名称不随登录凭据到期而删除。详见 [自动主机身份](specs/040-automatic-ssh-host-identity/spec.md)。

有限期登录凭据到期或撤销后清除；明确选择并确认“永久保存”时没有固定过期时间，直到主动撤销。两种保存方式均加密存储，Agent 激活不会提前清除；建议优先短期保存，使用结束后撤销。登记和凭据保存仍不会执行 SSH；凭据保存失败可在同一表单重试，使用已登记主机 ID，不重复创建主机。保存策略见 [SDD 039](specs/039-host-registration-credential-retention/spec.md)。

“运维工具 → 连接凭据”集中管理 SSH 私钥和密码，登记主机可选已有凭据或手动新增。主机绑定默认凭据后，终端、检查和安装/卸载自动使用；同一私钥按真实公钥指纹去重复用。主机解绑只影响该主机，全局撤销影响所有关联主机，秘密不回显。详见 [SDD 050](specs/050-connection-credentials-host-addresses/spec.md)。

主机栏同时展示 SSH 连接地址、SSH 预检或 Agent 发现的内网 IP 与其他网卡 IP、平台观测来源 IP，支持多网卡和 IPv6，并标明网卡采集来源与时间。SSH 网络发现是独立的只读步骤，缺少网卡工具不会改变核心安装检查结果。发现地址不改写 SSH 连接地址，IP 变化也不改变主机 ID。平台观测来源只表示 Agent 到平台的这条连接，可能是内网、NAT 或代理地址，不代表公网入口或其他连接的出口；反向代理需显式配置 `LIGHTMONI_TRUSTED_PROXIES` 的代理 IP/CIDR，才会采用可信转发链。设计与边界见 [系统设计 13.6–13.7](docs/system-design.md#136-集中连接凭据与主机默认绑定sdd-050) 与 [SDD 051](specs/051-ssh-host-network-discovery/spec.md)。

enrollment 由平台内部签发并预绑定该主机，安装器通过 SSH stdin 接收，不进入 URL、命令参数、环境变量或 AI 上下文。兑换、激活、注册和心跳使用预约与独立 control/data 凭据核验，注册不会创建第二台主机；没有独立 token 签发、用户手动安装和手工主机关联入口。旧无主机预约身份和共享 SDK Key 不再兼容控制面，不自动迁移或删除历史数据。完整流程见 [Agent 部署与恢复](docs/agent-deployment.md) 和 [SDD 038](specs/038-registered-host-agent-onboarding/spec.md)。

Agent 在宿主机以独立 systemd 服务运行，生命周期与业务服务分开。Linux amd64/arm64 包自带 Node 24.15.0，要求 glibc ≥ 2.28，无需另装 Node/npm；安装器验证 SHA256。持久目录保存身份、队列和日志游标，不应复制到另一台主机。主机管理首装拒绝覆盖已有安装；升级/回退有独立审批、固定包摘要、新启动健康确认、失败自动回退及未知结果核对，支持串行批次，仍需要有效 SSH 维护凭据。完整设计和任务中心统一演进方向见 [系统设计第 28 节](docs/system-design.md#28-agent-版本升级与回退sdd-045)，使用及兼容边界见 [部署文档](docs/agent-deployment.md#升级回退和卸载)。中心镜像更新不会自动更新用户主机上的 Agent。

SDK仅独立直报中心，安装Agent不是前置条件。Agent只将自身采集和任务数据通过内部持久队列上报，不提供SDK接收与配置代理。SDK与主机资产无隐式绑定；Agent内嵌同一SDK通过进程内exporter打点，业务启停不影响Agent。详见[SDK接入](sdk/README.md#中心地址与自动同步)。

“SDK接入”保留“SDK样例 / SDK密钥 / 豁免表”。“管理后台 → 接入凭据”展示 SDK 上报密钥、平台部署产生的 Agent 接入会话和节点凭据；安装会话仅查看状态/撤销，创建操作统一从主机管理发起。独立 control 用于心跳/配置，data 用于遥测，不交给业务 SDK。节点凭据只展示用途、状态和时间，撤销影响该节点对应用途的全部未撤销凭据；SDK Key 不授予 Agent 控制权。数据目录和保留时长位于“数据管理”，图表模板位于“监控大盘”。

任务中心统一展示平台默认任务与用户任务。平台自带指标采集、服务拨测和目录日志三条默认任务，Agent 接入后自动获取适用任务；缺少地址的拨测、缺少目录的日志显示“待配置”。默认任务可编辑和停用；新建直接编写或上传 Node.js／POSIX shell 脚本，以全部主机、主机 ID 或主机标签指定目标；主机可覆盖启用状态和采集参数。主机标签属于主机 ID，无 Agent 也可编辑，卸载、重装后保留。配置冲突整体拒绝并保留原有效配置。

脚本可上传或直接编写，支持手动、指定时间一次、固定间隔和带时区的日历计划。执行记录保留代码快照、状态和有限输出，支持取消、审阅当前定义后重试及人工核对未知执行。脚本以 Agent 用户权限执行，有超时和输出限制；非空参数或自定义工作目录要求 Agent task.script.v2。AI 只能查询和生成提案，由用户在任务中心明确批准。完整控制协议与边界见 [系统设计第 27 节](docs/system-design.md#27-任务中心与主机标签sdd-043) 和 [SDD 043](specs/043-task-center/spec.md)。

目录日志填写绝对目录、文件匹配规则（默认 `*.log*`）、是否包含子目录和首次从头读取。默认只采集现有文件后续新增的行，之后新建文件完整采集；读取进度与队列批次一起提交，支持重启续读、重命名轮转和截断检测。要求服务用户可读目录，采集 UTF-8 文本行，跳过压缩文件和符号链接；单行超过 64 KiB 分片，未结束的短行等待换行。事件时间使用采集时间，保留文件路径和字节位置。每个执行节点最多同时打开 256 个日志文件，每个目录单次扫描最多 10,000 个条目，超限会显示采集错误。源文件在采集前已删除或覆盖的内容无法恢复。

“SDK接入”生成四语言通用record样例。初始化必填service/env，地址与密钥可使用LIGHTMONI_ENDPOINT/LIGHTMONI_KEY；可选service_version/instance_id，实例标识默认自动生成。同一客户端可记录多个表和指标。SDK仅使用中心公网引导地址和SDK密钥；运行时同步内网地址。业务SDK退出前调用有截止时间的shutdown，Agent独立补传自身采集数据。容器通过environment/Secret注入配置，使用容器可达的地址，Docker Desktop可用host.docker.internal。

管理员可在“管理后台 → 接入配置”维护多个有名称的上报地址并选择默认项，例如“公网”和“内网”；SDK 示例可选择可达入口，未配置时使用 `LIGHTMONI_EXTERNAL_URL`。这些地址应指向同一 LightMoni 实例。Agent 安装使用平台部署计划中校验过的 HTTPS 中心地址，内部下载脚本、双架构包和 SHA256 清单由 `/downloads/agent/` 提供，必须使用该主机安装会话的有效 enrollment 鉴权；control/data 凭据与 SDK Key 不能替代安装授权。管理员标记内网/公网用途后，SDK和Agent每30秒同步地址，内网优先、公网备用；Agent控制、任务与上报共用入口。业务SDK仅直连中心，详见[中心地址同步](docs/center-endpoints.md)。

```ts
const moni = createLightMoni({service: 'order-api', env: 'prod'});
moni.record('business', 'db.query.duration_ms', {key1: 'mysql', key2: 'select'}, 128, 1);
await moni.shutdown({timeoutMs: 5000});
```

服务内接入页提供Go、Node.js、Rust、Python四种SDK包、安装命令、业务样例和校验。其他历史SDK源码保留兼容，未接入本次record周期协议。SDK业务窗口默认30秒，中心按表下发七档周期；显式flush可提交当前窗口增量，后台自动提交已结束窗口。

安装、API和可靠性边界见[sdk/README.md](sdk/README.md)。四语言record均有独立自动聚合，退出前仍需shutdown；可运行样例见[examples/sdk](examples/sdk)。浏览器通过业务后端转发，后端保管中心密钥；匿名仅使用启用的豁免表。

要在真实库中观察日志查询、服务/级别/属性聚合与指标，可运行本地业务流量程序：

```sh
node examples/sdk/traffic/index.mjs
```

程序在 `127.0.0.1:18419` 发起真实 HTTP 请求，通过SDK直报中心的三个测试服务，默认运行 30 分钟。可用 `LIGHTMONI_ENDPOINT`、`LIGHTMONI_DURATION_SECONDS` 调整接收地址和时间；历史执行节点路径已移除。这些记录用于测试，资源属性注明 `telemetry_source=sdk-traffic-fixture`。

## 工作台功能

- 多大盘、布局拖动缩放、多 SQL 面板、类型化变量、共享时间、自动刷新、图例与原始数据检查器；AntV 图表、真实目录生成的 SQL 样例与快捷模板。
- 日志探索、字段过滤、时间分布、详情与同源上下文、trace 关联、冻结分页、实时流、保存检索和导出。
- 图表按当前曲线设置阈值或没有打点告警，绑定人员责任组；支持固定/天/周排班、多主多备、P0～P3、接手与升级、静默窗口、日志现场、Trace树及接手率/时长统计。规则可继承数据表责任组，详见[告警响应与值班](docs/alert-response.md)。
- Webhook、飞书群/企业应用机器人、钉钉、企业微信、Pushplus 公众号推送；阿里云、腾讯云、华为云短信；阿里云、腾讯云电话语音；SMTP 邮件（QQ、163、126、腾讯企业邮、阿里企业邮预设及自定义服务器）。各渠道需填入自己的供应商配置，详见[通知渠道配置](docs/notification-channels.md)。
- 本地用户管理，以及微信网站登录、QQ 互联、GitHub、通用 OAuth2；提供 state、PKCE、稳定身份绑定、首次用户审核。
- 右上角统一展示账户名称与身份，提供个人设置和退出入口；支持全站简体中文 / English、深色 / 浅色 / 跟随系统及四种强调色。偏好保存在当前浏览器，切换保留当前输入；业务名称、日志、SQL、代码和模型回复保持原文。
- Mastra 驱动的 AI 助手：流式回答、工具时间线和中止；读取目录、生成 SQL、分析日志，预览并确认保存大盘。较早对话按完整轮次整理摘要，显示模型报告的用量；管理员可自动获取模型目录，配置 OpenAI Chat Completions、Responses、Anthropic Messages 或 Gemini 协议及输入、输出和执行步数限制。

应用控件使用 React 组件，不调用浏览器原生选择框、确认框或输入对话框。所有成员共享实例数据；管理员管理用户、凭证和供应商密钥。

## 本地开发和验收

本地构建建议使用 Node 24.15.0（运行时最低 Node 22.19），并准备可访问的真实 ClickHouse。测试Go SDK需Go 1.26+，测试Rust SDK需Rust 1.85+；中心与Agent运行无需这两种工具链，源码包打包复用锁定依赖清单。Docker Compose 用于容器部署，可在有 Docker 的环境启动隔离测试数据库：

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

Agent 发布脚本下载并校验 Linux 双架构的固定 Node 发行包；打包成功不代表已在相应 Linux 主机运行验收。已由平台部署并取得独立凭据的 Agent，其源码运行入口为 `node runtime/dist/agent/main.js run --config /path/agent-config.json`；这个命令不签发身份，也不能绕过主机预约。生命周期和业务应用分开管理，诊断与隔离开发说明见 [Agent 运行与恢复](examples/agent/README.md)。

另一个终端运行开发界面：

```sh
cd web
LIGHTMONI_DEV_API_URL=http://127.0.0.1:18880 npm run dev
```

历史 Go/Node 联调脚本 `scripts/demo-smoke.py` 用隔离开发实例创建测试管理员、允许 `http`/`app` 的 Key，运行 Go/Node demo，核对多服务计数、日志与 span 关联。默认地址 `127.0.0.1:18880`，默认测试用户名 `local-admin` / 密码 `local-demo-password`；只用于该测试工作流。主服务未初始化时脚本会初始化。

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

可通过 `LIGHTMONI_DOMAINS_USER` / `LIGHTMONI_DOMAINS_PASSWORD` 指定隔离测试账号。域联调覆盖真实 OTLP 入库、日志、Trace、大盘、SQL 告警和本地 Webhook；节点联调覆盖 SDK → Agent 磁盘队列 → 中心和重启补传。当前发布语言使用 `python3 scripts/test-sdks.py`；Docker 齐备时可用 `--docker`。四语言原生测试和周期专项验收见[验收记录](docs/evidence/metric-periods/README.md)。`python3 scripts/demo-smoke.py` 是保留的历史 Go/Node 业务示例检查，需要额外准备 Go 工具链。

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

## SDK密钥与豁免表

SDK密钥按名称创建，启用后可写所有合法业务表。旧权限字段经类型校验后忽略，现有密钥保留身份并使用同一规则；禁用后所有后续请求与重试仍被拒绝。无Authorization仅能写入当前启用的豁免表，错误或空凭据不会降级。SDK接入页管理密钥、豁免表，管理后台保留SDK凭据入口；Agent enrollment/control/data凭据继续按节点和用途隔离。

## 数据与可靠性边界

自有 SDK 批次在冻结后保持内容和 ID 不变。执行节点在 SQLite WAL 持久化后 ACK，主服务在 ClickHouse 写入及批次确认后 ACK。内部 ReplacingMergeTree 配合公共 `FINAL` 视图去重，避免丢 ACK 重试造成计数翻倍。普通 OTLP 未提供稳定批次 ID 时遵循至少一次交付。SDK 缓存有界且只在进程内；执行节点磁盘队列有容量、重放时间和保留期限制，不承诺无限离线缓存。

只读 SQL 通过 AST 校验和独立查询账号；禁止私有表、跨库、外部表函数和自行设置资源限额。默认每次最多 8 个查询、10 秒执行、10,000 行展示。时间范围为 `[from,to)`，`UInt64` / `Int64` / Decimal 结果保留字符串。指标 `value_float` 保存原始浮点，`value_int` 保存精确整数，公开 `value` 为浮点；整数汇总使用 `sum(toDecimal256(value_int,0))`；图表超出安全精度时要求明确选择近似展示。日志/链路默认保留 7 天，指标 30 天。

详细方案：[docs/architecture.md](docs/architecture.md)、[docs/contracts.md](docs/contracts.md)。验收证据和未验收项：[docs/acceptance.md](docs/acceptance.md)。没有真实账号凭证的第三方登录、通知和 AI 供应商只能标注协议测试，不能视为真实供应商验收。Grafana / Kibana 核心交互以任务矩阵逐项验证；不作未经对比测试的性能或完整功能等同承诺。

## 仓库与贡献

后续开发和问题反馈使用 [workhold/lightmoni](https://github.com/workhold/lightmoni)。Gitea 原仓库保留历史 PR、评论与验收来源；文档中的历史 Gitea PR 链接指向原记录，不与 GitHub 的 PR 编号混用。Git 迁移保留提交历史，平台上的 PR 评论、评审和 Issue 不会随 Git push 自动迁移。

贡献使用 SDD：先写规格、设计和任务，再实施与验收，最后通过功能分支提交 PR。架构变更必须同步仓库系统设计和 Doca 基线，具体要求见 [AGENTS.md](AGENTS.md) 与 [贡献指南](CONTRIBUTING.md)。

## 许可证

LightMoni 自有代码使用 [Apache-2.0](LICENSE) 许可证。第三方代码及依赖保留各自许可，包括 [Spec Kit 的 MIT 许可](.specify/LICENSE) 与 [Doca 参考代码声明](web/src/features/assistant/NOTICE.md)。

### 系统自监控

初始化会建立 `lightmoni_center`、`lightmoni_agent`、`lightmoni_sdk` 三个历史兼容入口；新系统遥测统一写入lightmoni_log/lightmoni_metric_*，以component区分center/agent/sdk，并创建「系统监控 · 上报中心 / 执行节点 / SDK」大盘。系统表通过标准查询、日志浏览和图表告警使用；首次初始化之后保留大盘编辑，也不会在重启时重新创建用户主动删除的大盘。Node 迁移仅将未编辑的旧 Go 运行指标面板一次性更新为活跃资源和事件循环延迟，并保留版本记录。

中心记录上报接口 QPS / 响应状态 / 耗时、首次成功确认的记录数与 OTLP 字节数、Node 堆内存、活跃资源、事件循环延迟和自监控队列；重复批次只增加接口请求次数，不重复计算接收量。执行节点控制心跳转换成在线状态、队列和采集诊断；启动、配置变更与执行失败日志在中心 SQLite 暂存，写入 ClickHouse 成功后清除。SDK 自监控在原有业务权限验证后自动分流到系统 SDK 表。见 [SDK 内部监控](sdk/README.md#内部监控) 和 [本机封装 SDK 示例](examples/self-monitoring/README.md)。
