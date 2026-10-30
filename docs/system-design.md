# LightMoni 系统设计基线

> 状态：当前主干的 HLD/LLD 设计基线；2026-10-20 建立。本文是系统联动的总入口，特性变更仍必须通过 SDD（spec、plan、tasks、validation）交付。
>
> 配套变更：[SDD 019：系统设计基线](../specs/019-system-design-baseline/spec.md)。

## 1. 文档定位与事实来源

LightMoni 是面向个人和小团队的一体化监控工作台。它把业务 SDK、独立 LightMoni Agent、中心服务、Web 工作台、AI 助手、告警和主机接入放在一套可独立部署、可追踪和可恢复的系统里。本文件回答四个问题：系统为什么这样设计、组件如何联动、请求和数据怎样流动、当前实现与未来目标分别是什么。

本文件是跨模块设计的权威入口，但不是每个模块的唯一契约。字段、状态码和验收步骤以更细的 SDD 和公共契约为准。出现冲突时，采用以下优先级并开新 SDD 修正旧文档：

1. 当前可运行代码和公开 API 的实际行为。
2. 当前主干中最新的特性 SDD 契约和验证记录。
3. `docs/contracts.md`、`docs/architecture.md`、`docs/brief.md` 等共享设计。
4. 历史任务说明、早期 Go 实现和未完成的规划文字。

“当前”表示代码或验证证据已经存在；“兼容”表示为了已部署版本保留；“目标”表示设计方向，必须经过新的 SDD 和验证才能变成当前能力。本文不以规划代替测试。

### 1.1 变更维护与双端同步

本文的仓库来源是 [`docs/system-design.md`](system-design.md)，在线协作副本是 [Doca：LightMoni 系统设计基线](https://doca.heyphp.com/#/r/2902a80f-c592-414e-9aed-64fe19f2ed53)。任何影响组件职责、数据或控制路径、凭据边界、存储、协议、部署拓扑或 AI/工具边界的架构变更，都必须在同一个 SDD 和 Pull Request 中同步更新这两个位置。

同步时保留 Doca 的原生图块和无关内容；写入成功后使用最新版本回读目标章节或图块，核对文字、节点和连线。Pull Request 必须记录架构影响判断、仓库文档章节、Doca 链接和回读结果。Doca 不可访问、鉴权失败或保存未确认时，不得声称设计已同步。不影响架构的改动填写“不适用”及理由即可；凭据不得写入仓库、日志、URL、Pull Request 或文档正文。

## 2. 驱动目标

### 2.1 产品目标

- 让用户在一台中心服务上完成主机、业务指标、日志、Trace、拨测、告警、通知和 AI 分析。
- 让业务服务用少量代码记录结构化数据，不需要先设计复杂的指标注册表。
- 让 Agent 独立运行并成为节点级执行平面，承接主机采集、拨测、文件日志、任务配置、心跳和离线补传。
- 让 AI 助手基于真实目录、查询、告警、模型和主机状态工作，并在产生副作用前给管理员清晰的可审阅回执。
- 让小团队在不引入 Redis、Kafka、Grafana、Kibana 或专用网关的情况下完成部署；ClickHouse 专注遥测数据，SQLite 专注管理状态。

### 2.2 工程目标

- **可恢复**：网络中断、进程重启、丢 ACK、部分写入和 Agent 离线时，系统能说明哪些数据仍可重试、哪些已丢失。
- **可演进**：中心、Agent 和 SDK 共享公共协议；新的功能通过 SDD 增量加入，不把页面实现当作协议。
- **可审计**：凭据、主机、AI 提案、告警响应、部署计划和模型用量都有结构化状态和操作者。
- **可控成本**：SDK 在端侧有界聚合，AI 有输入、输出和步数限制，ClickHouse 查询和日志浏览有资源上限。
- **安全默认**：最小权限、凭据分用途、不把秘密交给模型、不把 SSH 变成长期运维通道。
- **可理解**：一个请求、一个批次、一个任务和一个提案都能追溯到发起者、目标、结果和下一步。

### 2.3 非目标

首版不承诺多租户、逐表 ACL、完整 PromQL/KQL/Lucene、完整 IDE、自动发布、Agent 任意远程 shell、节点侧模型调用、跨文件崩溃事务、无限期离线补传或高可用集群。需要这些能力时必须先新增或修订 SDD。

## 3. 设计原则

1. **独立上报、路径显式**：业务 SDK 默认直连中心，Agent 独立上报自身任务数据；两者复用同一套 SDK 包，业务上报不依赖安装 Agent。已有显式 SDK 经 Agent 能力单独说明，不因网络错误自动互相改投。
2. **Agent 是一等节点**：业务退出不会停止 Agent；Agent 不只是 SDK 的中转器，也不等同于“采集器”这个单一功能。
3. **控制面和数据面分离**：控制凭据用于心跳和配置，数据凭据用于遥测；SDK Key、Agent local token、enrollment token 不能混用。
4. **中心是配置权威**：任务、标签、告警、模型、密钥和部署计划在中心保存；Agent 只缓存可执行配置，SDK 只缓存端侧规则。
5. **写入先确认边界再确认成功**：Agent 先持久化再 ACK，中心等待目标 ClickHouse 写入完成再 ACK；未知结果保留原批次。
6. **AI 提案优先于 AI 副作用**：查询可以直接读，保存大盘、修改告警、部署 Agent、应用代码 diff 必须回到用户确认接口。
7. **结构化回执优先于原始输出**：页面和模型收到固定状态、错误码、ID 和摘要；私钥、密码、令牌、原始 SSH 输出和上游秘密永不进入上下文。
8. **共享模块而非隐式耦合**：HTTP、SQLite、ClickHouse、目录、查询、凭据和时间由公共服务注入，模块不能自己重建权限或 SQL 规则。

## 4. 系统边界与核心概念

### 4.1 核心对象

| 对象 | 定义 | 生命周期拥有者 |
| --- | --- | --- |
| 用户 | 登录中心的管理员或成员 | 中心 SQLite |
| SDK Key | 业务直连中心的数据上报凭据 | 中心凭据管理 |
| Agent enrollment token | 绑定已登记主机的一次性短期安装凭据 | 主机部署内部签发，中心兑换 |
| Agent control credential | 节点心跳、配置和控制通道凭据 | 中心签发，Agent 保存 |
| Agent data credential | 节点遥测上报凭据 | 中心签发，Agent 保存 |
| Agent local token | 可选的本机 SDK → Agent 鉴权令牌 | 目标 Agent 本地配置 |
| 执行节点 | 一个独立运行的 LightMoni Agent 实例 | Agent 身份与中心节点记录 |
| 任务 | 指标采集、服务拨测或目录日志配置 | 中心任务仓储 |
| 任务标签 | 把任务分发给节点的标签集合 | 中心标签仓储 |
| 业务表 | SDK 记录的逻辑表名 | 中心目录与 ClickHouse |
| 批次 | 一个 signal、table、service 和稳定批次 ID 的发送单元 | SDK/Agent/中心链路 |
| 告警规则 | 对查询结果进行求值并产生 episode 的配置 | 告警域 |
| 提案 | AI 产生但尚未应用的变更或代码结果 | 中心 SQLite |
| 业务服务 | 用户希望被打点、构建和部署的逻辑服务 | 中心 SQLite |
| 服务目标 | 服务在一台登记主机上的运行实例及适配器配置 | 中心 SQLite |
| 制品版本 | 带版本、来源和 SHA-256 的不可变发布输入 | 中心 SQLite/受控制品存储 |
| 业务部署 | 将一个制品激活到一个服务目标的可审阅计划 | 中心 SQLite，Agent 执行 |

### 4.2 系统边界

LightMoni 中心管理身份、配置和可查询数据，但不拥有业务代码、用户主机的全部权限或供应商账单。业务 SDK 可在不安装 Agent 的后端中运行。Agent 可部署在主机、虚拟机或容器中；业务是否与它同机不是身份判断条件。SSH 只作为首次接入、人工维护和救援通道，Agent 激活后日常控制应走 Agent API。

## 5. HLD 总体架构

总览分为两个视图，避免把遥测、节点控制和浏览器入口混成一条链路。第一张图展示业务 SDK 与 Agent 各自上报中心：两个 SDK 节点表示同一套 SDK 包在不同进程中的实例。Agent 的采集和任务执行通过内嵌 SDK 打点，使用进程内 exporter 写入自己的持久队列，再由 Agent 发送。业务 SDK 的数据不经过 Agent。

**独立数据上报与节点控制：**

```mermaid
flowchart LR
  subgraph Business[业务进程]
    App[业务服务]
    SDK[LightMoni SDK]
    App --> SDK
  end
  subgraph Node[LightMoni Agent 独立进程]
    Collector[主机/进程/拨测/文件日志采集器]
    NodeSDK[Agent 内嵌同一 SDK]
    Agent[Agent 持久队列与上报器]
    Collector -->|打点| NodeSDK
    NodeSDK -->|进程内 exporter| Agent
  end
  subgraph Center[LightMoni 中心]
    HTTP[遥测接收 API /v1/*]
    Control[节点控制 API]
    SQLite[SQLite 管理状态]
    CH[ClickHouse 遥测正文]
  end
  SDK -->|HTTPS / SDK Key| HTTP
  Agent -->|HTTPS / data credential| HTTP
  Agent -->|心跳、配置与任务 / control credential| Control
  HTTP -->|校验后写入| CH
  Control -->|节点身份与任务配置| SQLite
```

图中的箭头表示调用或发送方向；心跳、拉配置与部署任务的 claim/events/result 使用 control credential，响应沿原请求返回，遥测上报使用 data credential。任务配置由中心持有，节点主动拉取；这里没有新增中心主动连接 Agent 的入站要求。SDK → Agent 的现有显式转发能力见第 7.2 节，不作为当前推荐的业务主路径，也不因本次图示修正而删除。

**用户入口与中心内部模块：**

```mermaid
flowchart LR
  subgraph UI[同一 Web 工作台内的用户入口]
    Web[React/TypeScript 工作台]
    AIUI[AI 助手界面]
    SSH[SSH 终端小窗]
  end
  subgraph Center[同一个 Node.js/TypeScript 中心服务]
    API[中心管理 API / 登录会话]
    Auth[认证与凭据]
    Catalog[目录与查询]
    Domains[大盘/日志/告警/通知域]
    Assistant[AI 助手与审批]
    SQLite[SQLite 管理状态]
    CH[ClickHouse 遥测查询]
  end
  Web --> API
  AIUI --> API
  SSH -->|WebSocket / 管理员会话| API
  API --> Auth
  API --> Catalog
  API --> Domains
  API --> Assistant
  API -->|共享状态仓储| SQLite
  Catalog -->|统一 Query| CH
```

图中拆开的 API 和领域模块是同一中心进程内的逻辑职责，不是新增的独立服务。鉴权先于领域处理；内部模块复用统一目录、查询与状态仓储，不在图中逐条展开依赖。AI 助手界面和 SSH 终端是两个用户入口，不相互调用；模型没有任意 SSH 终端权限。

### 5.1 部署拓扑

默认部署是一个中心容器加一个可访问的 ClickHouse；SQLite、加密主密钥和 Agent 包/队列使用持久卷。Agent 作为独立进程或容器运行，使用自己的数据目录、身份和队列。SDK 与业务服务一起运行，不要求和中心同机，也不要求 Agent 必须存在。

```mermaid
flowchart TB
  Browser[浏览器] -->|HTTPS| Proxy[可选反向代理]
  Proxy --> Center[LightMoni 主服务 :8080]
  Center --> CH[ClickHouse HTTP :8123]
  Center --> State[SQLite + secrets + outbox]
  Service[业务主机/容器：服务 + SDK] -->|HTTPS / SDK Key| Proxy
  AgentA[用户主机 A：独立 Agent + 同一 SDK] -->|HTTPS / data 与 control 凭据| Proxy
  AgentB[用户主机 B：独立 Agent + 同一 SDK] -->|HTTPS / data 与 control 凭据| Proxy
```

图中反向代理是可选的：不部署时，这些 HTTPS 请求直接到可访问的中心入口。Agent 的 data 凭据仅用于遥测；control 凭据用于心跳、配置和部署任务的 job claim/events/result。业务主机与 Agent 主机可以是同一台，也可以分别部署；图中分开表示进程与凭据独立，不要求业务先找到 Agent 的本地端口。TLS 可以由已有反向代理承担。中心外部地址必须能被 Agent 和直连 SDK 访问；容器中 `localhost` 只表示当前容器。发布的 Agent 包为 Linux amd64/arm64，并自带固定 Node 运行时；目标主机不需要另装 Node/npm。

## 6. 组件职责和依赖方向

| 组件 | 主要职责 | 不应承担 |
| --- | --- | --- |
| `runtime/src/server` | HTTP、认证、模块装配、管理 API、接收和后台任务 | 不把业务查询散落到 Web 或 AI |
| `runtime/src/domains` | 大盘、日志、告警、通知和领域状态机 | 不直接绕过公共 Query/目录 |
| `runtime/src/agent` | 节点身份、采集、拨测、文件日志、接收、持久队列、上报、心跳 | 不持有中心模型 Key；不执行任意远程命令 |
| `sdk/*` | 轻量记录、端侧窗口聚合、OTLP、重试和上下文传播 | 不保存磁盘队列；不决定平台权限 |
| `ai-runtime` | Mastra worker、provider 适配、流式事件和工具 loop | 不拥有中心权限或秘密存储 |
| `runtime/src/assistant` | 会话、工具、审批、Pi 代码任务、模型用量 | 不直接让模型写数据库或 SSH |
| `web` | 用户交互、展示、草稿和确认 | 不持有 API Key、私钥或模型供应商秘密 |
| SQLite | 管理配置、身份、状态、摘要、凭据摘要、队列元数据 | 不保存大量遥测正文 |
| ClickHouse | 日志、指标、Trace 及查询视图 | 不成为管理权限的唯一来源 |

中心是模块化单体，不拆为运行时微服务。模块通过 `Dependencies` 使用共享 DB、目录、查询、认证、路由、加密、时钟和日志；启动和关闭由 `runtime/src/server/app.ts` 管理。

## 7. 端到端数据流

### 7.1 业务 SDK 直连中心

1. 业务初始化 SDK，必填 `service` 和 `env`，可选版本和实例 ID。
2. SDK 按 `record(table, metric_name, dimensions, value, count)` 写入内存窗口；日志和 Trace 捕获调用时的上下文。
3. SDK 在 UTC 固定窗口结束后冻结批次，生成稳定批次 ID、创建时间和 OTLP payload。
4. SDK 向中心 `/v1/metrics`、`/v1/logs` 或 `/v1/traces` 发送 Bearer SDK Key。
5. 中心验证逻辑表、Key、批次头、OTLP schema、时间和容量，写入 ClickHouse 物理表。
6. 写入确认后返回 OTLP ACK；SDK 释放同一批次。失败保留原批次并按策略重试。

直连是 SDK 的默认目标，适合普通服务器、容器和 Serverless。安装 Agent 不是直连的前置条件。

### 7.2 已有可选能力：业务 SDK 经 Agent

本节记录已有的显式转发实现，供需要本地持久化和离线补传时选择。它不是总览主路径，也不是业务 SDK 的安装要求；本次系统设计图示修正不新增、删除或切换运行时能力。

1. 用户明确选择 `LIGHTMONI_MODE=agent`，SDK 使用 Agent endpoint 和可选 local token。
2. SDK 仍在业务进程内聚合和生成 OTLP，不把中心 control/data credential 暴露给业务。
3. Agent 接收请求，验证 table、batch ID、时间和 local token，把批次持久化到本地 SQLite 队列后 ACK SDK。
4. Agent 使用自己的 data credential 向中心发送完全相同的批次；网络失败时从磁盘队列重试。
5. 中心完成 ClickHouse 写入后，Agent 删除队列记录，但保留受限 receipt 去重。

Agent 模式增加本地持久化和离线补传能力，同时增加一跳网络与本地队列故障面。它不会自动压缩、自动合批、替换凭据，也不代表中心已入库。Agent 不可达时，SDK 不自动改投中心。

### 7.3 Agent 节点任务流

1. 管理员在“节点助手”创建任务和任务标签。
2. 节点通过 control credential 心跳并拉取按标签合并的 `RemoteConfig`。
3. Agent 先校验并缓存完整配置，再原子替换当前有效 revision；冲突配置整体拒绝。
4. 采集器按配置产生 host/process/probe/files 数据，使用 Agent 内嵌的同一 TypeScript SDK，经进程内 exporter 写入 Agent 队列。
5. Agent 上报并维护心跳、队列、采集器状态和有限运行事件。
6. 节点无匹配任务时暂停内部采集和拨测，但仍可接收业务 SDK 数据。

任务标签只负责分发，不是租户、权限或业务 service。一个节点可以有多个标签，一个任务也可以关联多个标签，命中任一标签即可下发且不会重复执行。

### 7.4 AI 分析与变更流

1. 浏览器通过中心创建/恢复会话，中心在私有 stdin/stdout 管道中启动 Mastra worker。
2. Mastra 使用管理员保存的模型连接配置调用协议 SDK；Key 只在后端和 worker 内存中存在。
3. AI 读取目录、描述表、执行有界只读 SQL、检索日志和读取告警状态。
4. 大盘、告警、静默、代码和 Agent 部署以 draft/proposal/plan 形式返回。
5. 用户在独立页面查看完整变更、影响、版本和回执，再由中心重新校验权限和 revision 后应用。
6. 每次实际模型请求写入幂等用量账本；模型目录刷新不发送生成请求，测试连接才发送最小真实请求。

### 7.5 SDK 插桩与业务部署流

1. 管理员为业务服务提供已授权的源码 workspace；AI 先调用只读 `scan_sdk_instrumentation`，识别语言、框架、LightMoni SDK、直连/Agent 模式和候选请求/错误边界。
2. 扫描不导入或执行业务代码，也不写文件。对于可以明确定位的 TypeScript/JavaScript 多行请求边界，AI 调用只读 `propose_sdk_instrumentation` 生成结构化 unified diff、风险、手动步骤和验证命令；Python、Go、Rust、Ruby 或歧义边界只给手动步骤。复杂改写才交给隔离 workspace 的 `code_task`，同样只产生可审阅 diff；所有 diff 都必须经过管理员确认后才应用。
3. 已确认的 revision 目标上由隔离构建器生成带版本、架构、来源 revision 和 SHA-256 的 release；构建器尚未实现前，systemd MVP 允许管理员上传预构建的 `lightmoni-release-v1.tar.gz`。Manifest 至少包含 `schema_version`、`service_id`、`version`、`architecture`、`source_revision` 和固定 `entrypoint:"run"`。中心上传与 Agent 暂存都会拒绝常见私密凭据路径，以及扫描窗口内匹配到的私钥、知名 token、URL/DSN userinfo、凭据查询参数、Basic Auth 和有值凭据字段；错误不回显匹配内容。该启发式检查不能保证检测所有秘密，bundle 仍只能包含运行文件，运行凭据须由目标主机的独立秘密管理注入。中心只保存元数据与私有 digest-addressed 正文，不能从静态下载路由取到业务制品；生产 Agent 不接收源码仓库凭据或模型密钥。
4. 管理员为 service 创建一个或多个 service target，登记 systemd unit 与受控 release directory。release 根目录由 root 持有并属于 Agent systemd unit 配置的 `lightmoni-agent` 主组（建议 `0775`，业务服务用户只读且可遍历，并且不得属于 Agent 组）；Agent 的 `ProtectSystem=strict` 沙箱需把该精确目录加入 `ReadWritePaths`。Agent 预检检查根目录 UID/GID 与 POSIX mode 位，要求 root 所有、Agent 有效主组可写、其他用户仅可读/遍历。MVP 不检查扩展 POSIX ACL，也不解析 systemd unit 的业务进程 User/Group/附加组；管理员必须确保业务用户不属于 Agent 组且无 ACL 写权限。unit 必须预先配置稳定入口 `ExecStart=<release_directory>/current/run`；LightMoni Agent 不编辑任意 unit、环境文件或服务用户。release bundle 只放运行所需文件，不能放密钥或环境凭据。MVP 的 `systemd` 适配器覆盖 Node、Python、Go、Rust、二进制和解释器服务；语言不是部署协议。Docker Compose、Kubernetes/Helm 和 CI/GitOps 作为后续适配器。
5. 管理员可请求目标 Agent 执行 `systemd.probe` 只读预检。Job 仅检查绑定的 unit 与 release directory，通过固定参数读取 systemd 属性和版本指针；输出限定为状态枚举、布尔值、安全版本标识、观测时间、一次性请求 ID、目标配置 revision 和固定错误码，不回传原始命令输出，也不创建目录或改变服务。Agent 确认 `ExecStart` 精确使用登记路径下的 `current/run`；中心校验请求 ID/revision 与观测时间，阻止跨 job 快照重放；路径含符号链接、unit 不符合入口、被 masked 或处于启动/停止过渡态时不标记 ready。文件系统检查仅在支持通过固定目录句柄拒绝符号链接的平台启用；当前实现为 Linux Agent，其他平台报告 `filesystem_check_supported=false` 且不就绪。中心按 target/operation 保存快照，部署计划可附最近 10 分钟且 ready 的预检结果。没有预检、预检过期或快照未就绪都不能得到可执行动作。
6. 中心执行 `probe → plan → apply → verify → rollback` 的受控计划层，生成 `awaiting_approval` 部署计划。计划只包含 typed actions，不包含 shell 字符串；管理员审批前中心要求 release ready、目标快照新鲜且 ready、manifest 与目标匹配，以及带能力授权的 health_check，随后原子写入不可变 Agent job 并把部署推进到 `agent_ready`。制品上传只允许管理员认证的有界接口；Agent 下载只允许 control credential、当前 lease 和 action 绑定的 agent/release/digest 同时匹配，不接受任意 URL，秘密不进 URL。
   - 中心 bundle 上传以进程级单槽门限制并行收件与同步校验；槽位占用时不排队并返回 `503 artifact_upload_busy`。管理员可通过 `POST /api/v1/admin/release-artifacts/gc` 先 dry-run 再确认清理超过 24 小时且未被任一 release 引用的私有对象；每轮最多扫描 10,000 项并删除 500 项，且与上传互斥。达到上限时用当前进程内最多有效 5 分钟的不透明游标续扫，游标绑定扫描模式和初始保留期截止时间；每轮重新读取引用。新扫描、进程重启或超时会使旧游标失效。存储祖先必须通过与读取一致的 UID/写权限校验，内部符号链接和硬链接不参与回收。这允许回收旧孤儿，但不消除单个最大 bundle 的解析内存峰值，也不提供硬磁盘配额或集群级协调。
7. Agent executor 通过 control credential 拉取短时租约 job。中心后台定期处理过期任务，按单调序号接收阶段事件，并将 staging/activating/verifying/final receipt 映射到脱敏部署时间线。只有 verifying 后的最终回执包含 `health.healthy=true` 才标记业务 deployment `succeeded`；未领取 job 可以安全取消或过期取消。普通部署若执行结果未知或成功回执不完整，保留最后确认的部署阶段并将 receipt 标为 `unknown`，要求检查目标主机，不推断为部署失败；回滚操作的未知结果或不匹配回执则结束本次操作，将 deployment 标为 `failed`、receipt 标为 `unknown`，管理员完成新的安全预检后才能显式重试。此状态仅表示 Agent 报告计划内健康检查通过，中心遥测结论独立保存，由管理员显式发起 ClickHouse 核验，不能仅靠健康回执标记遥测成功。
8. 管理员若要回滚，先为目标执行新的只读 preflight。仅当快照新鲜且结构安全（允许 unit 为 `active`、`inactive` 或 `failed`）、current 仍指向本次部署版本、previous version 是同一 service 下登记的 ready release、Agent 在线时，中心才创建受限 rollback job。Agent 通过 current-pointer CAS 恢复 previous version，随后 restart 并执行 systemd health check；中心同时核对 `health.healthy=true` 和回报的 current version 才转为 `rolled_back`。首次部署、CAS 冲突或旧版本未登记时拒绝创建任务。执行结果未知或回执不匹配会结束当前操作并将部署标为 `failed`、receipt 标为 `unknown`，提示人工检查；系统不自动重试，只有管理员再次执行新鲜安全预检且 current 仍是本次部署版本后，才可显式创建新的回滚操作。

9. 管理员可在 target 的可选 `config.telemetry` 中绑定规范业务公开表、SDK `service.name` 和稳定 `service.instance.id`；绑定进入目标 revision 与不可变部署快照，配置变更会使既有预检/计划和旧核验结果过期。SDK 必须自行设置 `service.version=release.version`；平台随机 service ID 不能用于推断 SDK 服务名。只有普通 deploy 已有有效 Agent 健康成功回执、目标配置仍匹配且没有后续已批准操作时，管理员才能通过 `POST /api/v1/deployments/:deploymentId/verify-telemetry`（严格 `{}`）发起一次核验。
   - 观察窗口固定为 `[finished_at, finished_at+5min)`，查询时仅观察到 `min(now, window.to)`，并限制 `ingested_at` 在完成时间至核验时刻之间；接收等待截止为完成后 6 分钟。SDK 服务、实例和发布版本均须精确匹配，最多读取 1000 条身份/时间样本。该证据只证明部署完成后的匹配遥测已入库，不证明部署因果关系或 SDK 身份不可伪造，启动及健康检查前的数据不算入本窗口。
   - 中心从目录验证非系统、规范公开业务表和必需列，使用 ClickHouse reader 参数化值查询；不读取遥测正文或接收任意 SQL。单次最多执行 3 秒、5 秒取消、64 MiB 查询内存和 100 万扫描行；单进程只允许一个核验请求，不排队。查询前后校验状态/operation、完成时间、目标 revision、计划/快照、release 和后续批准 job 顺序，变化时丢弃结果。
   - SQLite `deployments.telemetry_json` 单独保存脱敏摘要和上下文指纹；GET 与 AI 只读工具显示 `verified/waiting/timed_out/unavailable/invalid/unconfigured`，未核验为 null，过期结论标记 `stale`。查询失败、超时或无配置均不改部署健康状态，不触发自动回滚。Web 仅提供手动核验/重试，无自动查询轮询。

部署的执行、健康结果和独立遥测核验通过以下通道联动：

```mermaid
sequenceDiagram
  participant Admin as 管理员
  participant Center as LightMoni 中心
  participant Artifact as 私有制品存储
  participant Agent as LightMoni Agent
  participant Host as 业务主机/systemd
  participant SDK as 业务 SDK（独立上报）
  participant CH as ClickHouse 业务公开视图
  Admin->>Center: 请求 systemd.probe 只读预检
  Center->>Center: 绑定目标配置 revision 与 Agent identity
  Agent->>Center: HTTPS claim（control credential）
  Center-->>Agent: 单一 systemd_probe action，无写能力
  Agent->>Host: 固定 argv systemctl show + 读取受控 current 指针
  Agent->>Center: 固定字段 preflight snapshot（不含原始输出）
  Center->>Center: 校验 Agent/target revision，保存 10 分钟快照
  Admin->>Center: 上传已构建的 release bundle
  Center->>Center: 校验 SHA-256、manifest、大小与 USTAR 路径
  Center->>Artifact: 原子保存到私有 digest-addressed 存储
  Admin->>Center: 基于新鲜快照和 ready release 生成服务计划
  Center->>Center: 绑定 previous version、typed actions 和 artifact 引用
  Admin->>Center: 审批带 health_check 的 typed plan
  Center->>Center: 原子创建 job 与 agent_ready 状态
  Agent->>Center: HTTPS claim（control credential）
  Center-->>Agent: 不可变 actions、capabilities、lease
  Agent->>Center: control credential + job lease 请求制品
  Center->>Center: 校验 agent/job/lease/release/digest 绑定
  Center->>Artifact: 读取制品流
  Artifact-->>Agent: gzip USTAR bytes + digest/size headers
  Agent->>Agent: 校验 SHA-256 并安全解包到 releases/<version>
  Agent->>Agent: CAS previous version，原子 current symlink 切换
  Agent->>Center: accepted/staging/activating/verifying 事件
  Center->>Center: 校验序号与阶段，追加脱敏部署时间线
  Agent->>Host: allow-list 部署和健康检查动作
  Agent->>Center: 最终 result 与健康检查回执
  Center->>Center: 成功/失败/unknown 状态迁移
  Center-->>Admin: 部署详情和时间线
  SDK->>Center: 独立 OTLP 上报，携带服务/实例/版本
  Center->>CH: 正常接收管道写入遥测
  opt 管理员手动核验部署后遥测
    Admin->>Center: verify-telemetry 空对象
    Center->>Center: 验证健康回执、快照绑定和当前部署上下文
    Center->>CH: reader 固定窗口/身份参数化查询（最多1000条）
    CH-->>Center: 有界身份和时间样本，无正文
    Center->>Center: 再次校验上下文；独立保存核验摘要
    Center-->>Admin: 遥测结果或已过期冲突；健康状态不变
  end
  opt 管理员请求取消
    Admin->>Center: cancel + expected_state
    alt 尚未批准或 Agent job 仍排队
      Center->>Center: 原子取消部署与未领取 job
      Center-->>Admin: cancelled
    else Agent 已领取
      Center-->>Admin: 409，要求先核查主机
    end
  end
  opt 管理员请求回滚
    Admin->>Center: 请求新的 systemd.probe 只读预检
    Agent->>Host: 读取 current version 与受控 unit 状态
    Agent->>Center: 回报绑定 revision 的最新快照
    Admin->>Center: 确认回滚并提交 expected_state
    Center->>Center: 校验 previous release、当前部署版本和 Agent 在线
    alt 没有 previous release 或 current version 已变化
      Center-->>Admin: 409，要求人工检查或拒绝自动回滚
    else 条件满足
      Center->>Center: 创建不可变 rollback job 与唯一 operation ID
      Agent->>Center: claim rollback typed actions
      Agent->>Host: current-version CAS 切回 previous release
      Agent->>Host: restart 已登记 unit 并执行 systemd health check
      Agent->>Center: 最终回执含健康结果和 current version
      alt 健康通过且 current version 等于 previous
        Center->>Center: 转为 rolled_back
        Center-->>Admin: 回滚成功和时间线
      else 结果未知或回执不匹配
        Center->>Center: 结束当前操作，deployment failed + receipt unknown
        Center-->>Admin: 要求检查主机并重新预检；不会自动重试
      end
    end
  end
```

当前代码已持久化 service、target、release、deployment 元数据及脱敏 `deployment_events`，提供 `awaiting_approval` 计划、管理员 approve、Agent 回执状态映射、事件查询和受限人工 systemd 回滚 job。回滚仅在新鲜且结构安全的 preflight 显示 current version 仍为本次部署、previous version 有同 service ready release 记录且 Agent 在线时入队；即使 unit 处于 failed，只要目标路径和入口安全也允许尝试恢复。Agent 执行 current-pointer CAS、systemd restart 和 health check，并核对回执 current version 后才标记 `rolled_back`。Agent 的只读 `systemd.probe` job 将目标配置 revision 与一次性 preflight ID 绑定，有效期最多 10 分钟；Agent 校验 `ExecStart=<release_directory>/current/run`，并以受控 bundle 的相对 symlink 维护 `current`。本轮已接入制品私有存储、管理员上传、control credential + job lease 绑定下载、USTAR 校验、安全解包和 systemd typed actions；digest 对象可被多个 release 共享，校验失败的上传不会立即按 digest 删除对象，管理员可在保留期后用有界 GC 清理无引用对象；没有 ready bundle、预检或 typed actions 的计划仍被审批 API 拒绝。

本轮将 bundle 限定为 gzip USTAR，要求 manifest 与可执行 `run`，只允许普通文件和目录；中心私有保存 digest 正文，Agent 下载须经 control credential + 当前 job lease + release/digest 匹配。Agent 在摘要验证后安全解包，并通过 CAS 与原子相对 symlink 将 `current` 指向 `releases/<version>`；目标 unit 由管理员预先配置为 `current/run`。管理员确认的受限回滚闭环及有保留期、引用检查和分批上限的手动孤儿 GC 已实现；手动、显式身份绑定的 ClickHouse 核验已接入；自动补偿、真实 ClickHouse/业务主机验收、生产签名与硬存储配额仍待后续切片。页面与 AI 不得把“预检通过”“已批准”或“已入队”当作业务已部署；`succeeded` 仅说明 Agent 报告计划内 health_check 通过，不能代表遥测已验证。

## 8. 中心服务 HLD/LLD

### 8.1 启动和模块装配

中心入口是 `runtime/src/server/main.ts`，创建配置、SQLite、ClickHouse、认证、路由和模块。模块在构造时执行自身迁移，`start()` 启动后台任务，`close()` 取消定时器、等待任务并关闭连接。健康检查 `/healthz` 不需要登录；其他 API 由统一 Router 注入 `Context.user`。

模块分层：

```text
HTTP Router / Auth
        ↓
server modules (nodes, machines, settings, ingest, query, install)
        ↓
domains (dashboards, logs, alerts, notifications)
        ↓
shared (SQLite, ClickHouse, OTLP, crypto, JSON, time)
```

### 8.2 认证和用户

本地账号、GitHub、微信、QQ 和通用 OAuth2 由中心处理。会话 cookie 只在同源请求中使用；OAuth state 一次性且绑定会话与用途，支持 PKCE 时启用 PKCE，OIDC 使用 nonce 和 token 校验。外部身份以 `(provider, subject)` 稳定绑定，不按昵称或未经验证的邮箱自动合并。管理员和成员共享实例数据，但凭据、用户管理、供应商配置、Agent enrollment、SSH 和 AI 变更只能由管理员执行。

### 8.3 接收和查询

接收端支持 OTLP HTTP JSON/Protobuf：`POST /v1/logs`、`/v1/metrics`、`/v1/traces`。统一请求头为 `X-Lightmoni-Table`、`X-Lightmoni-Batch-ID`、`X-Lightmoni-Batch-Created-At`。Query 使用 `POST /api/v1/query`，只允许已验证公开表上的有界只读 SELECT/WITH，参数绑定而非字符串插值。

查询统一使用 UTC 半开时间范围、正的 `interval_ms` 和带类型的 Frame。服务端限制查询数量、时间、行数、内存和 SQL 表集合；取消必须传入 ClickHouse。页面、告警和 AI 使用同一查询执行器，但各自有更小的结果和并发上限。

### 8.4 数据接入 API 族

| API | 用途 | 角色 |
| --- | --- | --- |
| `/api/v1/keys` | SDK Key 创建、启停和事件 | 管理员 |
| `/api/v1/sdk-config` | SDK 动态规则和窗口 | SDK/Agent |
| `/api/v1/catalog/tables` | 逻辑表目录 | 登录成员；修改管理员 |
| `/api/v1/metric-windows/:table` | 业务表聚合周期 | 管理员 |
| `/api/v1/agent-enrollments` | 列出、撤销接入会话；独立创建接口停止使用 | 管理员 |
| `/api/v1/agents/enroll` | Agent 兑换 enrollment | 安装器 |
| `/api/v1/agents/:id/activate` | Agent 激活 | Agent |
| `/api/v1/agent-credentials` | 凭据元数据 | 管理员 |
| `/api/v1/agents/:id/heartbeat` | 节点心跳/配置通道 | Agent control credential |
| `/api/v1/machines/*` | 受管主机、SSH、部署计划 | 管理员 |
| `/api/v1/services/*` | 业务服务、服务目标、制品版本和审核计划 | 管理员 |
| `/api/v1/services/:serviceId/releases/:releaseId/artifact` | 有界上传预构建 release bundle；正文进入私有存储 | 管理员 |
| `/api/v1/admin/release-artifacts/gc` | 预览或确认清理有保留期的未引用私有制品 | 管理员 |
| `/api/v1/agents/:agentId/jobs/:jobId/artifacts/:releaseId` | lease 与 release/digest 绑定的私有制品下载 | Agent control credential + job lease |
| `/api/v1/deployments/:id` | 脱敏部署计划/状态/回执查询 | 管理员 |
| `/api/v1/deployments/:id/events` | 脱敏部署状态事件时间线 | 管理员 |
| `/api/v1/deployments/:id/verify-telemetry` | 固定身份、版本与时间窗的独立遥测核验；严格 `{}`，单进程单槽 | 管理员 |
| `/api/v1/deployments/:id/cancel` | 取消未审批部署或尚未领取的 Agent job；已领取任务拒绝取消 | 管理员 |
| `/api/v1/deployments/:id/approve` | 管理员确认并推进到 `agent_ready` | 管理员 |
| `/api/v1/deployments/:id/rollback` | 新鲜预检、旧版本登记、CAS/健康回执满足时创建回滚 job | 管理员 |
| `/api/v1/agents/:id/jobs/claim` | Agent 拉取一个能力受限且带租约的部署 job | Agent control credential |
| `/api/v1/agents/:id/jobs/:jobId/events` | Agent 上报幂等阶段事件和脱敏快照 | Agent control credential |
| `/api/v1/agents/:id/jobs/:jobId/result` | Agent 提交成功、失败、取消或未知回执 | Agent control credential |
| `/api/v1/agent-jobs/:jobId/cancel` | 管理员取消尚未完成的 Agent job | 管理员 |
| `/api/v1/assistant/*` | 会话、模型、提案、用量和 AI 工具 | 登录/管理员按接口 |

## 9. 存储设计

### 9.1 SQLite

SQLite 保存低体量、强一致的管理状态：用户和外部身份、会话、SDK Key 摘要与事件、enrollment 状态、Agent 身份和凭据摘要、节点/任务/标签、主机和 SSH 凭据密文、业务 services/service_targets/releases/deployments、`agent_jobs`/`agent_job_events` 及其脱敏回执、部署计划、告警规则/episode/静默/outbox、仪表盘和草稿、模型配置/用量账本、表目录、窗口历史和有限队列元数据。

明文 secret 只在创建/兑换/轮换响应的单次边界出现，随后使用加密存储或不可逆摘要。SQLite 不保存大量日志、指标或 Trace 正文。

### 9.2 ClickHouse

单库 `lightmoni` 保存遥测。逻辑表名匹配 `[a-z][a-z0-9_]{0,47}`，不能自带 `log_`、`metric_`、`trace_` 前缀。公开视图按类型生成：`log_<table>`、`metric_<table>_sum`、`metric_<table>_gauge`、`metric_<table>_histogram`、`trace_<table>`。系统表使用 `lightmoni_*` 并用 `component=center|agent|sdk` 区分来源。

共用身份列包含 `event_id`、`event_time`、`ingested_at`、`service`、`instance_id`、`host_id`、`agent_id`、`key_id`、资源和类型保持信息。日志保存 severity、body、trace/span；指标按 sum/gauge/histogram 各自 schema；Trace 保存 parent、duration、状态、事件和 links。

底层使用稳定排序键和 ReplacingMergeTree 兼容重试，公开视图以 `FINAL` 去重。后台 merge 尚未完成不能被当作实时去重保证；读账号只能访问公开视图，写/迁移账号分开。

### 9.3 批次与幂等

一个自有 SDK 批次只有一个 signal、table 和 service。相同 batch ID 必须拥有相同创建时间和 payload；同 ID 不同正文返回冲突。中心用 batch ID、signal 和原记录位置生成稳定 event ID。重试、Agent 转发和凭据轮换不修改批次正文、原始时间或首次归因。

## 10. SDK 设计

### 10.1 公共 API

业务初始化必须提供 `service` 和 `env`，可选 `service_version`、`instance_id`；实例 ID 缺省自动生成。推荐入口为：

```ts
const moni = createLightMoni({ service: "order-api", env: "prod" });
moni.record(
  "business",
  "db.query.duration_ms",
  { key1: "mysql", key2: "select" },
  128,
  1,
);
await moni.shutdown({ timeoutMs: 5000 });
```

`dimensions` 只允许 `key1`～`key16` 字符串；`value` 是 `count` 个样本的总和。Counter、Gauge、Histogram、日志和 Span 保留旧 API 兼容，但新代码使用统一 record/上下文接口。W3C `traceparent`/`tracestate` 用于跨服务传播，日志在调用时捕获上下文，不在发送时读取另一个请求的上下文。

### 10.2 聚合和远程规则

SDK 默认使用 30 秒 UTC 固定窗口；每张业务指标表可选 10、30、60、300、600、1800、3600 秒之一。SDK 通过 `GET /v1/sdk-config?metric_windows=1`、停报和日志采样规则轮询；配置先验证后原子替换，失败保留上一份有效配置。查询步长须为实际窗口的整数倍，切换历史取公倍数对齐。

Go、Node/TypeScript、Python 等已接入的语言可按各自 SDD 使用动态停报、UID 排除、QA/VIP 保留比例；未接入某规则的语言必须在发布矩阵中明确标注，不能通过中心入库后补过滤来假装支持。

### 10.3 两种上报模式

| 模式 | 环境变量 | 接收端 | 凭据 | 持久化 |
| --- | --- | --- | --- | --- |
| `direct`（默认） | `LIGHTMONI_ENDPOINT`、`LIGHTMONI_DATA_KEY` 或兼容 `LIGHTMONI_KEY` | 中心 `/v1/*` | SDK data key | SDK 进程内有界缓冲 |
| `agent` | `LIGHTMONI_AGENT_ENDPOINT`、可选 `LIGHTMONI_LOCAL_TOKEN` | Agent `/v1/*` | Agent local token（如启用） | Agent SQLite 磁盘队列 |

模式必须由用户显式选择，不能在一条路径失败后静默改变授权或目标。两种模式都保持 OTLP、table、批次头和 shutdown 语义。SDK 不知道“业务所在机器的 Agent”是靠业务名称推断出来的；需要 agent 模式时，用户通过本机/容器可达地址或部署编排显式提供 Agent endpoint。未来可以新增服务发现，但不能把推断结果当作凭据。

## 11. LightMoni Agent 设计

### 11.1 定位

LightMoni Agent 是独立运行的系统级执行节点。它可以接收业务 SDK 数据，也可以使用同一套 TypeScript SDK 为自身主机采集和任务执行打点；业务 SDK 不必安装或经过 Agent。Agent 的进程由 systemd、容器编排或其他进程管理器负责，业务服务的启停不会影响 Agent。

### 11.2 模块

| 模块 | 职责 |
| --- | --- |
| `config.ts` | 地址、凭据、容量、任务和本地令牌校验 |
| `agent.ts` | HTTP 接收、上报、心跳、运行状态和 SDK exporter |
| `queue.ts` | SQLite durable queue、receipt、重试、容量和日志 cursor |
| `collect.ts` | CPU、内存、磁盘、网络、负载和进程采集 |
| `probe.ts` | HTTP/TCP 拨测和超时 |
| `file-logs.ts` | 目录日志增量读取、轮转、截断和分片 |
| `main.ts` | `run --config`、信号、启动和优雅关闭 |

### 11.3 节点控制协议

节点通过 control credential 注册/心跳并拉取 `RemoteConfig`，其中包含 revision、任务标签合并后的指标/拨测/日志配置和控制间隔。Agent 先校验、写入本地缓存，再应用 revision。中心不接受 Agent 在心跳请求体中自行声明的 `agent_id` 作为授权依据。

Agent 上报使用 data credential 和 `X-Lightmoni-Agent-ID`。队列至少一次交付；`receipts` 防止同一 batch 重复入队，队列满或磁盘不足时返回背压而不是 ACK 后删除。重启后继续发送原 ID；超过最大补传年龄的批次进入明确的过期/隔离状态。

## 12. Agent enrollment 与凭据

```mermaid
stateDiagram-v2
  [*] --> issued: 审批主机部署后内部签发 enrollment
  issued --> redeeming: 安装器 stdin 兑换
  redeeming --> pending_activation: 中心创建 agent_id
  redeeming --> expired: 超时/撤销
  pending_activation --> active: 健康检查后 activate
  pending_activation --> failed: 安装失败/取消
  active --> degraded: 心跳/配置失败
  active --> re_enrolling: 管理员重新接入
  active --> revoked: 撤销 control/data
  re_enrolling --> active: 新 enrollment 激活
```

流程如下：

1. 管理员在已登记主机完成 SSH 预检并审阅部署计划；中心内部签发绑定主机、版本/架构和初始任务标签的短期 enrollment。
2. 页面只展示部署计划与回执，不提供独立 token/安装命令入口；中心通过受保护 SSH stdin 将 token 传入固定安装器。
3. 安装器提交 token、install nonce、版本、架构和最小信息；中心核验预绑定主机仍存在且未被其他身份占用，同 nonce 重试幂等，不同 nonce 重放拒绝。
4. 中心创建待激活身份并返回 bootstrap；安装器仅用它发起激活，不写入运行配置。激活前暂存配置只做离线预检，不能运行 Agent；取得独立双凭据后再次严格校验配置，再启动服务并确认启动结果。
5. Agent 激活后取得 control/data credential，使用 fsync 和原子 rename 落盘；中心只保存摘要。
6. 撤销立即拒绝新请求；凭据自动轮换与有限 grace 窗口仍是后续能力，当前不能声称已自动轮换。

`control_credential` 只用于心跳、配置和控制；`data_credential` 只用于 Agent 遥测。Agent 不再接受旧 config.key 或共享 SDK Key 的运行/控制面降级；SDK Key 仍供业务 SDK 独立上报。原本地接收器不作为用户安装 Agent 的理由，业务 SDK 不依赖 Agent。

## 13. 主机、SSH 和 Agent 引导

主机是唯一机器资产，Agent 是它的管理通道；在主机或容器中安装并接入 LightMoni Agent、取得身份后才具备节点能力。登记主机本身不会创建在线 Agent；Agent 必须先登记主机，再通过平台部署并关联，不提供独立脚本接入。主机资产、Agent 身份、SSH 凭据和 control/data 凭据仍分别保存、授权和审计，登记资产不产生 SSH 权限或秘密。

平台自动安装默认在宿主机运行独立的 systemd Agent 服务，不与业务服务的启动、休眠或停止绑定。后续容器部署可选择独立 Agent 容器、Kubernetes DaemonSet，或在用户部署业务时显式注入 sidecar；本轮不实现自动 sidecar 注入，不默认改写用户业务镜像。容器内 Agent 的执行范围取决于真实挂载、命名空间和运行权限，不能仅因登记为节点就声称具备宿主机操作能力。业务 SDK 与 Agent 均可独立上报中心，SDK 不依赖 Agent 安装、不强制经 Agent 转发；Agent 需要自监控打点时复用同一公开 SDK。

前端统一“主机”入口，将主机列表、监控任务和任务标签放在同一工作区。所有列表行使用真实平台主机 ID，Agent 仅补充通道状态和任务；不再拼接无主机资产的独立节点行。主机展示 Agent 在线/离线、未接入、已卸载、已移除与 SSH 是否配置/恢复可用。旧 /machines、/agents 路由和任务深链继续可用。普通成员通过 Agent 的主机 ID/名称投影查看已接入主机和任务，不获取管理员 SSH 地址、凭据或生命周期操作能力。

Agent 接入只有“先登记主机、再由平台部署”路径。已认证 Agent 按已有绑定或服务端安装预约确定所属主机，注册/心跳不创建资产；enrollment 由中心预绑定已登记主机，兑换、激活和控制面均核验预约与关联。独立签发及手工主机关联入口移除，共享 SDK Key 不再用于控制面降级。不能按 hostname、出口 IP 或 Agent 本地 host_id 合并或认领主机。SQLite 事务防止提前注册造成重复资产或抢占其他 Agent；MVP 一条主机最多一个 Agent，容器 Agent 的执行范围不等于物理宿主机。

“移除节点”是中心侧归档操作：管理员二次确认后，在同一 SQLite 事务保存移除时间、操作者和原因，撤销该身份全部 control/data 凭据，并保留身份、凭据墓碑、遥测历史和审计。移除不停止或卸载远端程序，不删除主机，不撤销共享 SDK Key。未结束、已派发或结果未知的节点任务，以及待审批、执行中或结果未知的卸载流程阻止移除；重复请求幂等。默认节点列表排除已移除身份，管理员可查询历史；控制鉴权、数据鉴权和任务派发均拒绝已移除节点，禁止回退共享 Key 或由后续心跳复活。共享 SDK Key 不用于 Agent 控制面；旧无预约身份需从主机管理重新部署，不能通过撤销全局 SDK Key 实现 Agent 移除，也不恢复旧秘密。

节点承担已支持的周期指标采集、日志采集、拨测和受限运维任务。AI 助手通过中心授权工具发起已支持任务，中心完成权限校验和所需审批后派发，Agent 通过平台控制通道接收任务并回传有界结果；日常交互不要求 AI 持有 SSH 秘密，也不赋予模型任意远程 shell。SSH 保留为首次安装、固定身份核验、卸载及离线恢复通道。通用定时脚本调度、任意代码远程执行、Agent 自卸载以及 Agent 本地模型决策均不是本轮已交付能力。

登记须填写主机名称和 SSH 目标地址、端口及登录用户；连接凭据可稍后添加，Agent 可稍后部署。主机公钥及指纹在首次 SSH 握手时自动记录，无需用户填写或确认。观测 hostname 不自动成为可信 SSH 地址，管理员可编辑同一主机名称和目标连接。秘密提交后由服务端使用 AES-256-GCM 加密，主密钥独立于数据库保存，页面永远不回显；模型只能看到主机元数据、凭据 ID 和结构化检查结果。主机删除是管理员操作：先移除仍有效的 Agent 身份，并结束终端、检查、部署/卸载和未结束计划、撤销有效连接凭据后才可删除，避免后续心跳自动重建。移除/卸载 Agent 不删除主机资产，删除记录不等于远端程序已卸载。

SSH 是首次接入、临时维护和故障恢复通道。登记在单一表单中展示连接信息、登录方式、秘密输入与保存时长；登录方式为密码或 SSH 私钥。主机公钥和指纹不在表单输入，首次 SSH 握手自动记录，详情只读可见；后续连接自动核验已记录身份。密码与私钥统一默认按期限保存 6 小时（managed），到期或撤销后清空；可显式确认永久保存（permanent），无固定过期时间，直到管理员撤销。有限托管和永久凭据均不因 Agent 激活提前清除；建议优先短期保存。凭据保存失败保留原主机 ID，就地重试不重复登记。主机名称、ID、指纹是资产元数据，不随登录凭据期限过期。已有凭据期限不自动改变；显式 temporary/one_time 仍沿用短期/使用后清除语义。

SSH 预检是只读固定命令集合，检查网络、指纹、Linux、架构、systemd、权限、HTTPS 可达性及已有 Agent 安装。私钥或明确选用 temporary/managed/permanent 的可复用密码可用于预检、终端、固定身份核验和 Agent 安装/卸载；one_time 密码只用于一次预检或终端，结束即清除，无论成功、失败或取消。密码和私钥均经 ssh2 内存参数认证，不进入命令行、环境、进程 stdin、模型上下文或原始日志；enrollment token 单独经 SSH exec channel stdin 传递。密码不保存秘密摘要，历史密码指纹启动时清空；同一主机各类 SSH 操作互斥。

预检通过后生成持久化部署计划；管理员明确确认后，后端先保存 enrollment 与目标主机的服务端预约，再使用固定安装模板、有效凭据、stdin enrollment token 及版本/架构白名单执行。下载脚本和包需要鉴权，0600 curl 配置暂存 token；不进入 URL、argv、环境、日志或回执。生成计划、执行前和安装锁内拒绝覆盖既有安装。计划绑定主机名称及连接 revision，执行前改名使旧计划失效。Agent 注册早于安装回执时仍通过预约关联原主机，不另建资产；确认激活后完成回执与凭据清理，清除 temporary/one_time 秘密并保留有效 managed/permanent 凭据。失败但新 enrollment 已激活时，仅撤销本次节点凭据并提示核对，不影响已有节点。日常管理优先走 Agent。

卸载使用独立的持久化计划和回执。中心固定只读探测核对远端独立身份、主机关联、受管服务及未结束任务；同一节点卸载与任务按 agent_id 跨主机互斥。计划绑定主机名称、地址、端口、用户名、可信指纹、有效私钥或可复用密码、节点身份及 15 分钟预检有效期；目标或授权变化不能复用。网页提供预览、确认、取消和历史，AI 不能绕过确认执行卸载。

确认卸载后仅执行平台版本受控的固定脚本：核对标准路径受管 systemd unit，拒绝其他来源的同名服务，再停止并禁用独立服务，确认停止后移除服务文件、启动器和 Agent 运行目录；停止失败不得删除程序。默认保留 /etc/lightmoni-agent、/var/lib/lightmoni-agent、专用服务用户，以及业务部署、制品、容器和卷。保留配置与队列用于核查和数据恢复，不代表保留文件中的旧凭据仍有效，也不保证尚未送达的数据可自动补传。

成功核验要求程序路径已移除、服务 not-found 且未运行、远端身份一致、两个持久目录保留并且没有未完成任务标记。中心在同一 SQLite 事务中撤销该节点全部 control/data 凭据并完成卸载记录；已登记节点不能回退为 legacy Key 认证。保留主机、节点和卸载历史，重新接入需要新的 enrollment。运行中、已派发或结果未知的节点任务必须先完成或核对。卸载的 awaiting_approval、running、succeeded、failed、unknown、cancelled 分别记录审批、执行和结果边界；SSH 断连或结果不确定进入 unknown，不报告成功且不盲目重跑。管理员可触发固定只读 reconcile，原临时私钥到期后可以添加新的有效私钥用于核对；完全移除且身份和保留数据核验通过才补做凭据撤销并成功，完整程序仍在且服务状态明确、无生命周期锁或任务标记时记录失败并保留凭据，部分移除或不确定则继续 unknown。待审批或未知结果仍允许管理员用终端人工核查，但禁止改主机、删除或新建部署；实际执行与核对期间同主机终端和检查互斥。

凭据到期或撤销时同样清空当前记录的 `secret_encrypted`，保留 ID、策略来源、有效期、清除时间/原因和不含秘密的事件。有限凭据在启动时、读取/使用前和每 30 秒统一清理；永久凭据仅在明确撤销时清除，不以空期限计算为到期。统一有效性判断要求未撤销、秘密未清除，且永久策略无固定期限或有限期限在未来；关闭模块时释放定时器；清理幂等，并取消引用失效凭据的待审批计划，不改写正在运行的计划。终端租约在到期或撤销后失效。清空当前记录不等于擦除 SQLite WAL/free pages、备份、已进入有界操作的进程副本或远端 authorized_keys。

主机能力由后端按连接方式、忙状态及有效凭据计算 terminal、ssh_check、deploy_agent、uninstall_agent。active_reusable_ssh_credential_count 只统计私钥及 temporary/managed/permanent 密码，安装/卸载不能用含一次性密码或手动脚本的总数推导。界面展示能力及置灰原因；所有操作后刷新状态。未记录主机身份不会置灰，首次 SSH 操作自动记录。实现契约见 SDD 031、032、034、037、038、039、040。

网页终端是管理员本人使用的临时 PTY：同源 Origin、登录 cookie、首次自动记录且后续比对的主机公钥、单次 WebSocket 入口、输入/输出上限、10 分钟空闲和 30 分钟总时长。终端输出不持久化、不写日志、不发送给 AI。终端不是 AI 任意 shell 工具。

### 13.1 目标：主机接入状态与 SDK 归属（SDD 036，设计提案）

本节是待评审和实现的目标设计，不代表当前主机页面已具备 SDK 归属查询。“主机与节点”拟统一为“主机”，原管理通道改为接入状态，分 Agent、SDK、SSH 三项；不设置由任一通道推导的整机在线状态。旧路由、监控任务、任务标签和批量计划确认保留。

SDK 归属是后续显式资产绑定设计，不要求 SDK 安装 Agent。当前主机可先登记后配置 SSH，Agent 统一走 SDD 038 的登记主机部署流程，不再规划独立 Agent-only 资产入口；不能把容器 Agent 当作已核实物理宿主机。

SQLite 拟保存 SDK 归属的 host_ref、服务器认证得到的 key_id、service、instance_id、生效区间、revision、来源和审计。同一有效选择器最多关联一个目标；管理员从已观察到的候选明确确认，或在服务部署审批中确认准确 Key ID 和实例配置。客户端 host.id、hostname、来源 IP 和 SDK Key 不能单独证明主机归属；SDK 不发现本机 Agent，不增加注册或凭据签发协议。

SDK 心跳汇总使用 component=sdk 的规范化系统目录，按本页明确选择器有界查询。中心时钟计算 90 秒新鲜窗口与最多 30 秒未来偏差，同一条样本的 event_time、ingested_at 均须满足策略，且事件/接收时间属于当前归属生效后的范围；历史补传不能点亮新主机。查询失败、截断或时钟异常给出未知/原因，不能按 0 个在线处理；默认仅显示近期上报实例数，不以全部历史实例计算健康率。

Agent 显示未接入、在线、心跳超时、已移除或已验证卸载；没有绑定不等于未安装，受管安装不存在只由带时间的 SSH 检查证明。SDK 显示未关联、尚无可用心跳、近期上报、心跳超时或未知；自监控关闭/匿名/断网不直接推断业务停止。SSH 显示配置、指纹、有效凭据与最近检查，不声称持续在线。SDK 和 Agent 独立直报中心，任一通道状态不替代另一通道。

实例随机 ID 变化、新 Key、服务迁移和主机聚合不能静默继承归属。解除、迁移和删除需要明确确认、revision 守卫及事务审计，生效区间保留历史；卸载或移除 Agent 不解除已登记主机的 SDK 关系，不撤销共享 SDK Key。删除主机先预览 SDK 关系影响，旧删除/关联接口不能绕过新守卫；归属只用于观测展示，不授予 SSH 或 Agent 执行权限。

MVP 新主机资产与 SDK 归属/摘要接口仅管理员可用，成员保留原有 Agent/任务只读权限。AI 只可读取脱敏摘要和提出归属提案，不能批准。先交付命名及状态语义，再实现仅资产登记、归属与心跳查询，最后接入部署审批；每阶段以 SDD 036 的需求、HLD/LLD、拟议契约和验收清单为准，不把设计草图当已实现能力。

```mermaid
flowchart LR
  SDK[业务进程 + SDK] -->|SDK Key · 独立遥测| CH[中心接收 / ClickHouse]
  AG[LightMoni Agent] -->|data credential · 独立遥测| CH
  AG -->|control credential · 心跳 / 任务| CTRL[中心控制面]
  ADM[管理员 / 已审批部署] --> BIND[SQLite：SDK 归属记录]
  HOST[主机资产 / SSH 元数据] --> VIEW[主机接入状态聚合]
  CH -->|有界心跳查询| VIEW
  CTRL -->|Agent 状态| VIEW
  BIND -->|显式实例归属| VIEW
  VIEW --> UI[主机列表 / 实例详情]
```

### 13.2 当前：登记接入与平台主机标识（SDD 037）

主界面统一称“主机”，移除“脚本接入节点”按钮，主路径是登记主机、保存所选期限的凭据、SSH 预检、审阅确认后自动安装宿主机 Agent。此节记录 SDD 037 的登记改动；单屏表单与默认保存时长以 SDD 039 后续修订为准。SDD 038 进一步移除独立脚本接入与旧身份兼容，不删除用户数据库历史记录。登记资产本身不执行 SSH 或远端写入。

平台通过 managed_machines.id 和 name 标识主机资产。ID 在登记时由中心自动生成，作为不可变主键；名称由用户填写和修改，是展示名称而非唯一键。同名主机通过不同 ID 区分，改名不改变资产 ID、凭据归属或已有 Agent 关联，界面详情保留稳定 ID 供核对。

本轮不创建或展示 SDK 主机环境变量，不扩展 SDK 读取能力，不在安装参数、Agent 配置或 SDK 遥测中注入平台资产 ID/名称。SDK 与 Agent 各自独立上报的既有路径保持；主机与 Agent 的绑定继续走已认证身份和现有受管关联流程。

SDD 036 的完整 SDK 归属表、显式绑定和双时间心跳汇总仍是目标设计。当前仅完成平台内主机身份、凭据有效期和登记安装主路径，不从主机名称、地址或 SDK 声明自动认定归属。

```mermaid
flowchart LR
  REG[管理员登记主机] --> META[平台自动生成 ID / 用户填写名称]
  REG --> CREDS[所选期限的加密 SSH 凭据]
  META --> RECORD[平台主机资产记录]
  CREDS --> APPROVE[预检 / 审阅确认]
  APPROVE --> AG[固定安装 Agent]
  AG --> LINK[已认证 Agent 关联]
  RECORD --> LINK
  LINK --> CENTER[中心平台管理]
```

### 13.3 当前：登记主机与 Agent 身份一体化（SDD 038）

主机是唯一资产入口：先登记平台 ID / 用户名称，再按需保存指定期限的 SSH 凭据、预检、审阅确认并安装 Agent。中心内部签发 enrollment 必须预绑定已登记主机，公共独立签发接口停止创建新 token。兑换、激活及注册/心跳核验预约和独立凭据，首次注册与绑定在 SQLite 事务内完成；注册早于安装回执仍关联原主机。客户端提交资产 ID 不具有关联效力。

注册/心跳不建档、不修改归属，不回填旧独立 Agent，不支持手工关联与历史协议降级；无主机预约的 token/身份拒绝接入，不能通过 SDK Key 控制面 fallback。旧数据库记录保留，不自动删除用户资产。重新部署保留原主机 ID：旧身份须已移除或全部凭据失效、没有未完成任务，新的有效 SSH 预检确认远端无 Agent，再由新安装预约的旧身份快照完成原子替换，保留旧身份历史。移除或卸载 Agent 后保留主机，主机有有效 Agent 身份时不可直接删除；旧身份卸载回执不能决定新身份的状态或删除权限。

用户名称与 observed_hostname 分离，心跳不覆盖名称或 SSH 配置。登记须填写名称与 SSH 目标地址、端口、登录用户，凭据可稍后添加，主机公钥与指纹首次 SSH 握手自动记录；管理员可编辑名称及目标连接，凭据按用户选择的期限保存。Agent 本地 host_id 保留遥测资源含义，不作为平台主机 ID；同名、共享出口或容器身份不能自动识别同一物理宿主机。成员只获取主机 ID/名称与原有 Agent 可见信息，不获 SSH 元数据。SDK 独立直报，不增加 SDK 环境变量、主机发现或 Agent 依赖。

```mermaid
flowchart LR
  REG[登记主机 / 平台 ID / 用户名称] --> CREDS[按期限保存 SSH 凭据]
  CREDS --> REVIEW[SSH 预检 / 审阅确认]
  REVIEW --> RESERVE[中心预绑定 enrollment 与主机]
  RESERVE --> INSTALL[平台安装 Agent]
  INSTALL --> AUTH[认证注册 / 核验主机预约]
  AUTH --> HOST[关联原主机 / Agent 管理通道]
  HOST --> UI[唯一主机列表 / 状态与任务]
```

### 13.4 当前：单屏登记与统一凭据保存时长（SDD 039）

登记主机的同一表单直接显示主机名称、地址、端口、用户名、密码或 SSH 私钥输入及保存时长。主机公钥/指纹由首次 SSH 握手自动记录，无需填写或确认。默认登录方式为密码，默认保存 6 小时；可选择有限期限或永久保存。公钥/指纹在详情只读显示并用于后续 SSH 服务端自动核验，既不是 SSH 登录公钥，也不能替代密码/私钥；指纹与平台 ID/用户名称作为资产元数据保留。管理员仍可明确选择仅登记、稍后添加凭据，登记本身不执行 SSH。

API 有限策略为 managed，默认 expires_in_seconds=21600；永久策略为 permanent，必须显式 confirm_permanent=true，且不得同时提交有限秒数。数据库以 expires_at 空字符串表达无固定期限，仅在 retention=permanent 时有效；不使用虚构的远期时间戳。秘密仍加密绑定主机和凭据 ID，不回显、不进入 AI、日志或审计正文。

统一有效性用于计数、终端、SSH 检查、安装/卸载、批量及 AI 脱敏凭据选择：未撤销、秘密未清除，且永久无固定期限或有限期限晚于当前时间。Agent 激活保留 managed/permanent；撤销清空密文、终止引用终端并使待执行计划失效。永久凭据不代表终端会话或部署计划无限期；原空闲/总时长、固定目标指纹、预检 TTL 和人工审批继续生效。

登记表单用原主机 ID 重试秘密保存，失败不重复建档、不执行 SSH；关闭窗口或更换登录方式清理秘密输入。已有凭据保持其既定期限，旧 temporary/one_time 行为明确独立，不改变统一主机登记和 SDK 独立直报架构。

```mermaid
flowchart LR
  FORM[单屏登记主机] --> META[主机 ID / 名称 / SSH 目标]
  FORM --> SECRET[密码或 SSH 私钥 / 加密保存]
  SECRET --> TTL[按期限 / 默认 6 小时]
  SECRET --> PERMANENT[永久保存 / 显式确认]
  TTL --> USE[有效凭据 / 预检与审批后使用]
  PERMANENT --> USE
  TTL --> CLEAR[到期或撤销 / 清除秘密]
  PERMANENT -->|管理员撤销| CLEAR
  CLEAR --> STOP[断开终端 / 待执行计划失效]
```

规格、契约与验收见 [SDD 039](../specs/039-host-registration-credential-retention/spec.md)。

### 13.5 当前：自动记录 SSH 主机身份（SDD 040）

登记和编辑只接收用户名称、SSH 地址、端口和用户名；登录密码或私钥按 SDD 039 的时长独立保存。主机公钥、SHA256 指纹及首次记录时间由中心产生并只读返回，API 拒绝客户端写入。主机页不再展示连接凭据安全提示横幅，登记和编辑也不展示身份输入或确认。

SSH 固定命令和网页终端统一使用 ssh2，在同一实际连接的 hostVerifier 中处理服务端公钥；不依赖单独 ssh-keyscan 后无条件信任另一条连接。首次握手在认证前，以主机 ID 和 SSH 端点原子固定公钥及指纹；已有指纹只允许匹配后补全公钥。重复连接匹配已记录身份，变化则拒绝连接，不覆盖旧身份、不执行远端命令。首次使用信任（TOFU）不包含带外首次身份核验，也不把自动记录描述为人工验证。

保存身份时重新核对活动操作、凭据状态、主机端点与当前指纹，阻止过时或竞争结果。首次记录后终端租约和预检使用更新的 revision，安装及卸载计划继续绑定该身份、有效凭据、目标与预检期限；生成计划不执行程序，人工执行审批保持。影响 SSH 目标的编辑以单调递增的 ssh_target_generation 纳入 revision，同时删除旧检查、取消待审批计划，避免端点 A→B→A 复用旧结果。地址或端口修改额外清空公钥/指纹/记录时间；仅改用户名称或登录用户名保留同一端点身份。认证完成后、执行命令前仍重新验证授权与目标；已经开始执行的操作按真实回执收敛，不因中途凭据到期伪造失败。

管理员在详情只读查看和复制主机公钥/指纹及记录时间；未连接显示“首次 SSH 连接后自动记录”。成员与 AI 的可见范围保持原有脱敏边界。没有指纹不阻塞首次预检、终端或批量操作，缺少有效凭据、互斥、权限和既有计划约束仍由后端能力决定。

```mermaid
flowchart TD
  REGISTER[登记主机与登录凭据] --> CONNECT[发起 SSH 预检或终端]
  CONNECT --> SEEN{已记录主机公钥?}
  SEEN -->|首次握手| PIN[原子记录公钥 / 指纹 / 时间]
  SEEN -->|已记录| MATCH{实际公钥匹配?}
  PIN --> AUTH[使用密码或私钥认证]
  MATCH -->|匹配| AUTH
  MATCH -->|变化| STOP[停止连接 / 保留原记录]
  AUTH --> USE[执行预检或打开终端]
  PIN --> DETAILS[主机详情只读展示公钥和指纹]
```

规格与验收见 [SDD 040](../specs/040-automatic-ssh-host-identity/spec.md)。

## 14. AI 助手设计

### 14.1 运行时分层

Mastra 是 LightMoni AI 助手的主对话和工具编排运行时。中心每轮通过私有 stdin/stdout 管道启动 Node worker；模型连接由 provider 适配 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 和 Google Gemini。Pi Agent 不是另一个平台入口，而是 Mastra 在 `code_task` 中调用的受限代码执行器，负责“读取 → 修改 → 检查 → 修复”的多轮循环。

```mermaid
sequenceDiagram
  participant U as 管理员
  participant W as Web
  participant C as 中心 Assistant
  participant M as Mastra worker
  participant P as Pi code task
  participant D as 目录/查询/告警/主机
  U->>W: 输入问题
  W->>C: 会话请求
  C->>M: 私有管道 + 配置
  M->>D: 受限工具调用
  M->>P: 需要轻量代码时调用
  P-->>M: 有界 diff/检查回执
  M-->>C: 流式文本/工具事件
  C-->>W: SSE 事件
  W-->>U: 回答或待审阅提案
```

### 14.2 工具分级

| effect | 示例 | 应用方式 |
| --- | --- | --- |
| `read` | list/describe tables、run_query、日志、告警读取、主机状态、业务部署事件 | 有界执行，可直接返回 |
| `draft` | dashboard draft、alert change、silence、SDK `propose_sdk_instrumentation`、Agent deployment plan | 保存或返回提案，用户审阅 |
| `code` | Pi `code_task` | 隔离副本、检查、diff，用户确认应用 |
| `execute` | 当前不提供模型任意 SSH/命令 | 未来单独 SDD，默认关闭 |

AI 的查询必须走目录和统一 Query，SQL 只读、有时间范围和结果上限。告警规则和静默的修改使用 revision/版本检查和 15 分钟提案有效期；应用时重新检查权限、版本和对象状态。代码任务只在管理员配置的 workspace 中运行，限制路径、符号链接、文件大小、白名单检查命令、步数和时长；Pi 不 commit、push、PR、merge 或 deploy。

### 14.3 模型管理与用量

管理员在“模型管理”保存 Base URL、协议、模型和输入/输出单价。自动识别只给地址和目录依据推荐；第三方 OpenAI 兼容目录无法区分 Chat/Responses 时必须人工选择。各协议独立规范化 `/v1`、`/v1beta`、目录鉴权和生成接口；修正后的地址回填输入框并说明原因。目录刷新不产生生成费用；连接测试发送一次最小真实请求。

每个真实模型请求使用稳定 request ID 幂等写入账本，记录 started、usage 和终态，区分 complete、partial、unpriced、failed、cancelled。缺失 token 不能猜成零，模型输入、Key 和回复正文不写入用量统计。

## 15. 告警、静默和通知

告警规则使用统一 Query 执行器，以固定窗口求值。规则显式声明来源表，目录表可提供默认责任组；多组路由按 group 独立生成响应。episode、响应、接手、升级、静默和通知 outbox 是独立状态机，通知失败不能阻塞采集。

AI 可以读取规则、静默和责任组的脱敏信息，也可以创建待确认的规则/静默提案。应用时使用对象 revision 和范围权限，重复确认返回原回执，配置冲突返回 409。通知渠道秘密只在中心保存，AI 不读取联系方式和供应商 Key。

## 16. Web 工作台设计

主侧栏包含概览、监控大盘、日志、链路、告警、节点助手、数据接入、数据管理、管理后台和 AI 助手。登录用户与身份位于右上角；颜色支持浅色、深色、跟随系统和强调色；界面支持简体中文/English。语言和外观保存在浏览器，不改变业务名称、日志、SQL、代码、凭据和模型输出原文。

页面只使用共享 React 控件，不使用浏览器原生 select、alert、confirm、prompt。SDK 接入提供独立上报说明、SDK Key 和豁免表；数据管理提供目录、保留和采样；模型管理提供连接、目录、测试、价格和用量；节点助手提供节点、任务和标签；主机管理提供预检、部署计划和终端。

前端不持久保存真实凭据。登录秘密仅在管理员填写并确认保存时提交中心，提交后不回填；后续 SSH、模型和部署请求只携带登录 cookie 与资源 ID，秘密解密及执行由中心后端完成。所有修改页面都要处理加载、失败、权限、冲突、过期和重试状态。

## 17. 安全和信任边界

### 17.1 凭据矩阵

| 秘密 | 生成/保存 | 使用位置 | 禁止位置 |
| --- | --- | --- | --- |
| SDK Key | 中心创建；密文/摘要 | SDK → 中心 | Agent control、模型、浏览器持久化 |
| enrollment token | 已登记主机部署内部签发；中心摘要 | 固定安装器 stdin/FD | URL、argv、env、日志、AI |
| control credential | 中心兑换；Agent 0600 文件 | 心跳/配置/控制 | 遥测、SDK、模型 |
| data credential | 中心兑换；Agent 0600 文件 | Agent → 中心遥测 | 控制 API、业务 SDK |
| local token | 用户在 Agent 本地配置 | SDK → Agent | 中心签发、AI上下文 |
| SSH 私钥/密码 | 中心 AES-GCM；统一默认按期限保存 6h，可显式确认永久保存；有限到期/撤销清除，永久撤销清除；主机指纹为独立元数据 | 后端固定 SSH worker/终端；Agent 激活清理临时凭据 | 浏览器持久化、模型、日志 |
| 模型 API Key | 中心加密 | 私有 Mastra worker | 浏览器、URL、模型消息 |

### 17.2 通用安全规则

- Host key 采用首次使用信任（TOFU）：同一握手先原子固定公钥再认证，首次无需用户确认；后续必须匹配，变化时停止且不自动覆盖。地址/端口改变清空该端点身份及旧预检/计划，不能关闭后续校验。
- 主机地址只接受主机名/IP，不接受 URL、用户信息、命令、控制字符或云元数据地址。
- AI 工具 schema 使用 `additionalProperties:false`；未知参数、任意 command、任意 host 和任意 key 直接拒绝。
- 凭据撤销和会话降权应在受限时间内断开终端；离线 Agent 的缓存任务不能被文档宣称为即时停止，直到配置租约实现。
- 日志、审计和错误只记录固定错误码、资源 ID、操作者、时间和脱敏摘要。

## 18. LLD：关键接口与状态机

### 18.1 OTLP 请求

```text
POST /v1/{logs|metrics|traces}
Authorization: Bearer <key-or-agent-data-credential>
X-Lightmoni-Table: <logical-table>
X-Lightmoni-Batch-ID: <UUID>
X-Lightmoni-Batch-Created-At: <RFC3339Nano UTC>
Content-Type: application/json | application/x-protobuf
```

200/202 表示整批接受；400 表示永久协议错误；401/403 表示凭据问题；429/502/503/504 可按 Retry-After 重试；未知网络结果保留原批次。自有链路不使用 partial success 丢掉未知子集。

### 18.2 Agent 接收与队列状态

```text
received → persisted → forwarding → acknowledged
                     ↘ retry_wait → forwarding
                     ↘ quarantine / expired / rejected
```

`persisted` 才能向 SDK ACK；`acknowledged` 才能回收队列 payload。队列 SQLite 保存 input hash、forward hash、身份、创建时间、attempts、next time、last error 和日志 cursor。容量不足返回可重试背压。

### 18.3 告警响应状态

```text
rule evaluation → episode open → unclaimed → acknowledged → resolved
                         ↘ cancelled / silenced / escalated
```

episode 状态与业务条件状态分开；静默只抑制通知和响应计时，不删除采集数据。接手必须通过已登录确认链接或供应商回调完成，GET 不产生副作用。

### 18.4 AI 提案状态

```text
drafted → awaiting_approval → applying → applied
                           ↘ expired / rejected / conflict / failed
```

提案绑定用户和会话，应用时检查 owner、权限、对象 revision、有效期和当前连接。重复应用返回原回执，不重复写入。代码任务的 `awaiting_approval` 只代表 diff 审阅，不代表已经写回工作区。

## 19. 可靠性、容量和故障处理

系统采用至少一次传输和查询去重，不承诺 exactly-once 网络交付。SDK 内存缓冲在进程崩溃时可能丢失；需要跨重启补传时使用 Agent durable queue。队列满、磁盘满、凭据错误、永久拒绝和过期批次都必须出现在 stats、节点状态或日志中。

ClickHouse 写入前后的 SQLite 状态不是跨数据库原子事务；中心只能在写入确认后 ACK，部分写入由稳定 event ID 和公开视图 `FINAL` 抵抗重复。掉电、异步 insert、磁盘耗尽和长时间补传需真实环境验证。

查询、日志历史和 AI 工具都使用有界会话：日志冻结分页有行数/内存/TTL；实时查询用重叠窗口和 event_id 去重；AI SQL 最长 90 天、10 秒和 1000 行样本；代码任务按文件/输出/步骤/超时限制。超过边界要返回显式 truncated/error，而不是静默给出不完整结论。

## 20. 部署、升级和运维

### 20.1 中心

```sh
cp .env.example .env
chmod 600 .env
docker compose config --quiet
docker compose pull
docker compose up -d --no-build --wait
```

根 Compose 默认同时运行中心与 ClickHouse；`deploy/with-clickhouse` 作为兼容目录继承两个服务。中心使用发布镜像 `docker.heyphp.com/lightmoni/lightmoni:20261026-admin`（Linux amd64/arm64），通过 `LIGHTMONI_CH_URL`（默认 `http://clickhouse:8123`）、`LIGHTMONI_CH_USER/PASSWORD` 接入数据库；ClickHouse 使用同一账号密码环境变量，不向宿主机映射端口，中心等待其健康后启动。启动时初始化 `lightmoni` 数据库和读账号。升级保留 SQLite、加密主密钥、队列和 ClickHouse 数据卷；备份必须同时保存状态卷、遥测卷和 `.env`。源码构建仍可显式 `build lightmoni` 后 `up --no-build --pull never --wait`。

### 20.2 Agent

发布脚本构建 Linux amd64/arm64 包和 SHA256；安装脚本校验 HTTPS、版本、架构和包完整性。Agent 以独立 systemd 服务或容器启动，`node runtime/dist/agent/main.js run --config /path/agent-config.json` 是源码运行入口。重装和升级保留 identity、凭据（若未撤销）、配置 revision 和队列；安装失败不能删除已有节点数据。

### 20.3 关闭顺序

中心停止接收新后台任务，等待可取消请求，关闭 AI worker、通知 outbox、目录轮询、ClickHouse writer 和 SQLite。业务 SDK 先停止生产再在截止时间内 `shutdown`；Agent 先停止采集，再等待队列尝试，最后关闭 HTTP server 和 SQLite。

### 20.4 管理员初始化与密码恢复

系统没有默认管理员或默认密码；空用户库允许网页首次设置，或由有本机/容器执行权限的运维人员运行 `lightmoni-admin init --name <name>`。运维命令直接访问 `LIGHTMONI_DATA/lightmoni.db`（容器 `/data/state`），复用中心 users/sessions 表、bcrypt cost=10 和 SQLite WAL/事务，不启动 HTTP、ClickHouse、AI worker 或主密钥初始化。此入口属于本机状态卷管理边界，不能作为 HTTP 后门或 AI 工具调用。

`reset-password --name <name>` 仅修改已有管理员的 bcrypt 密码哈希，并在同一 `BEGIN IMMEDIATE` 事务清除该用户所有登录会话；不提升成员、不创建未知用户、不改变启用状态。`init` 在事务中重查用户数，仅允许空库创建启用管理员，避免与网页初始化并发覆盖。密码由无回显终端双次输入或显式 `--password-stdin` 单行受限输入提供，至少 8 个 Unicode 字符、最多 72 个 UTF-8 字节；不进入 CLI 参数、Compose 环境、镜像层、日志或文档正文。具体命令与验收见 SDD 023。

## 21. 可观测性和审计

中心、Agent、SDK 自身使用 `lightmoni_*` 系统表记录心跳、队列、重试、丢弃、拒绝、配置 revision、采集器和模型用量。系统遥测不应递归记录原始请求、Key 或任意异常全文。每个系统级事件至少包含 component、service/agent_id、instance_id、时间、事件名和固定计数。

审计对象包括：登录和身份绑定、Key 创建/撤销、enrollment/激活/轮换/撤销、SSH 检查/部署/终端、任务和标签修改、告警提案应用、代码 diff 应用、模型连接测试和价格修改。审计只保存资源 ID、操作者、结果、版本/摘要和错误码，不保存 token、密码、私钥、提示词或生成正文。

## 22. 当前实现、兼容路径和限制

### 22.1 当前已实现或已有验证证据

- 中心和 Agent 使用 Node.js/TypeScript；Web 使用 React/TypeScript；AI runtime 使用 Mastra。
- SDK、Agent、中心共享 OTLP 和公共 TypeScript 类型；Agent 使用同一个 TypeScript SDK 做内部指标和 exporter。
- 节点标签/任务、Agent enrollment、control/data 凭据、主机 SSH 预检、部署计划和网页终端均有对应特性 SDD。
- SDD 021 已加入业务服务/目标/发布元数据、只读 SDK 插桩扫描、受限 TS/JS 结构化插桩提案、管理员确认后的安全 apply、中心部署状态迁移/审批/事件/人工回滚 job、Agent job/租约协议、MVP capability executor/runner 和 AI 部署计划工具。approve 要求带授权 capability 的 health_check 并创建不可变 job；Agent 的有序阶段回执、健康成功证据、取消和 unknown 结果已联动部署状态。Agent 可通过隔离的 `systemd.probe` job 对登记目标做只读主机预检，中心保存绑定目标配置 revision 的 10 分钟快照；它不会改变主机或推进部署状态。本轮已落地 release bundle 格式、私有存储、job-scoped 下载、有界管理员孤儿 GC、受限解包、current symlink 激活、CAS 回滚和 systemd typed actions；已加入管理员手动 ClickHouse 遥测核验与独立结果；真实 ClickHouse/业务主机验收、自动补偿、源码构建、签名、硬配额和 Docker/Kubernetes 适配器仍未完成。
- AI 具备目录、查询、日志、告警读取、可审阅草稿、SDK 插桩提案、业务部署状态/事件读取、Pi 代码任务和模型用量/连接测试设计。
- 告警规则、静默、值班、通知 outbox 和现场取证由中心域模块负责。

### 22.2 兼容路径

- `/agents` 工作区与 `group_id`/`--group-id` 标签字段仍存在；Agent 独立脚本接入、config.key 和手工关联已移除。SDK 构造 API 的版本策略与 Agent 接入分别管理。
- 旧数据视图和历史物理列不因新 record 模型删除。
- 浏览器入口和历史深链接通过重定向兼容到“数据管理”“模型管理”和“节点助手”。

### 22.3 当前必须保持诚实的限制

- SDK 发布语言矩阵仍需以目标分支的 `/api/v1/sdk-install`、发布脚本和 SDD 012 对齐；源码存在的历史 SDK 不等于当前发行包已承诺支持。PHP 不在当前发布目标；Go/Rust 若标记为后续支持，页面必须显示 deferred 而不是可下载。
- SDK 远程停报、日志采样和规则配置不是每种语言都已接入；未支持的语言不能声称平台规则已生效。
- Agent 离线时撤销不能即时停止其已缓存任务，配置租约仍是后续强化。
- SSH 终端是管理员临时工具，不给 AI 增加任意 shell 能力。
- 代码任务副本不是操作系统沙箱；白名单命令只适用于受信 workspace，不能当成不可信代码隔离。
- ClickHouse 的掉电可靠性、极端容量、Linux 实机和完整 Docker 发布需要按证据目录继续验收。

## 23. 演进路线

1. **一致性门**：统一 SDK 发布矩阵、接入页、下载 API 和验证 fixture；清理过时的 Java/C#/PHP 发布文字。
2. **Agent 强化**：配置租约、凭据持有证明、在线升级、更多 OS、受限 Agent Executor；每项先建 SDD。
3. **服务发现**：在 K8s/sidecar/本机部署场景增加明确的 Agent endpoint 注入或服务发现协议，不凭主机猜测身份，不改变 direct 默认。
4. **AI 工具扩展**：在中心实现受审计的 Agent 操作 API 后，再让 AI 调用节点工具；不把 SSH 作为长期路径，也不让节点获得模型 Key。
5. **数据和告警**：增加更强的降采样估算、依赖抑制、事件关联和大规模查询优化，同时保留明确的截断与计价状态。
6. **规模化**：只有在小团队单体部署的资源和可靠性证据充分后，再评估多租户、HA、分布式队列或独立查询服务。

## 24. 设计决策记录

| 决策 | 结论 | 原因 |
| --- | --- | --- |
| SDK 是否必须经过 Agent | 否；默认直连，可选 agent 模式 | 直连路径简单，Agent 只在需要离线队列/节点能力时增加 |
| Agent 是否随业务启停 | 否 | 节点采集、拨测、日志和控制需要独立生命周期 |
| Agent 是否自带模型 | 当前否 | 模型 Key、计费和会话属于中心；未来节点工具另行设计 |
| SDK 与 Agent 是否用同一 SDK | 是 | 统一记录、批次、上下文和系统自监控语义 |
| Mastra 与 Pi 的关系 | Mastra 主导会话和工具；Pi 只负责受限代码任务循环 | 保持中心权限和审批单一入口 |
| SSH 是否是日常控制 | 否 | 首次部署/救援使用，激活后优先 Agent control |
| 凭据是否合并管理 | 页面统一展示，权限和生命周期分开 | 降低操作复杂度但不扩大权限 |
| 是否自动把模型目录当协议证明 | 否 | OpenAI 兼容目录无法证明 Chat/Responses 或工具能力 |

## 25. 相关文档索引

- 产品约束：[docs/brief.md](brief.md)
- 旧架构叙述与部署摘要：[docs/architecture.md](architecture.md)
- 公共协议：[docs/contracts.md](contracts.md)
- Agent 安装与恢复：[docs/agent-deployment.md](agent-deployment.md)
- 网页 SSH 终端：[docs/machine-terminal.md](machine-terminal.md)
- UI 交互：[docs/ui-design.md](ui-design.md)
- SDK 总览：[sdk/README.md](../sdk/README.md)
- 任务索引：[docs/tasks/README.md](tasks/README.md)
- Mastra 助手：[SDD 001](../specs/001-mastra-assistant/spec.md)
- 模型发现和协议：[SDD 002](../specs/002-model-discovery/spec.md)、[SDD 003](../specs/003-multi-protocol-models/spec.md)、[SDD 005](../specs/005-model-management/spec.md)
- Agent、迁移和凭据：[SDD 006](../specs/006-execution-nodes/spec.md)、[SDD 007](../specs/007-node-runtime-migration/spec.md)、[SDD 010](../specs/010-agent-deployment/spec.md)
- SDK 数据与模式：[SDD 010 telemetry](../specs/010-telemetry-table-model/spec.md)、[SDD 011](../specs/011-aligned-metric-windows/spec.md)、[SDD 012](../specs/012-sdk-reporting-choice/spec.md)
- AI 告警、主机和终端：[SDD 009](../specs/009-assistant-alert-controls/spec.md)、[SDD 013](../specs/013-ai-alert-controls/spec.md)、[SDD 014](../specs/014-managed-machines-agent-bootstrap/spec.md)、[SDD 017](../specs/017-assistant-ssh-bootstrap/spec.md)、[SDD 018](../specs/018-machine-web-terminal/spec.md)
- 设计基线 SDD：[SDD 019](../specs/019-system-design-baseline/spec.md)
- AI SDK 插桩与业务部署：[SDD 021](../specs/021-ai-sdk-instrumentation-deployment/spec.md)
- 在线设计副本：[Doca：LightMoni 系统设计基线](https://doca.heyphp.com/#/r/2902a80f-c592-414e-9aed-64fe19f2ed53)
- 架构文档双端同步规则：[SDD 020](../specs/020-architecture-design-sync/spec.md)
- 镜像发布与管理员运维：[SDD 023](../specs/023-registry-admin-cli/spec.md)

## 26. 运维平台基础与备份恢复（SDD 026，网站/容器现行设计见第33章）

### 26.1 驱动目标与范围

在现有监控、主机、Agent、服务部署和 AI 助手之上，为个人及小团队提供可追溯的日常运维闭环：登记资源 → 生成方案 → 管理员批准 → 节点执行 → 真实验证 → 记录结果。第一批覆盖小型静态网站、反向代理、证书与受管 Compose；第二批覆盖目录备份、恢复和计划任务。不复制第三方面板代码，不引入第二个控制面。SDK 默认直连中心、Agent 独立运行，均不因运维功能改变。

### 26.2 HLD 与控制路径

```mermaid
flowchart LR
  U[管理员 Web] --> R[中心运维资源与方案 API]
  AI[中心 Mastra AI 助手] --> T[读取与提案工具]
  T --> R
  R --> P[不可变方案 / 加密配置]
  U --> A[人工批准 / 绑定资源版本]
  S[管理员显式授权的计划任务] --> A
  P --> A
  A --> J[Agent job / capability / 租约]
  J --> N[独立 LightMoni Agent]
  N --> L[control 身份 + 有效租约读取私有载荷]
  L --> E[typed 领域执行器]
  E --> W[独占 Nginx / Certbot]
  E --> C[Docker / Compose 项目]
  E --> B[受管目录 / 本地或 S3 备份]
  E --> V[现场验证与有界回执]
  V --> R
```

AI 工具只有 `list_operations_resources`、`get_operations_run`、`propose_operations_action`，不会批准或直接执行。所有工具重查当前用户的管理员角色。静态文件和 Compose 正文只向模型提供数量、大小、服务名与镜像等摘要；列表按上下文预算分页，提案保存后只返回 ID、状态与审阅链接，避免大正文导致已保存提案却返回失败。原始业务日志可能包含无法穷举的凭据，因此日志回执只在管理员界面展示，不自动交给模型。AI 可返回 `/operations?run=<id>` 供人审阅。读取现场状态本身也作为明确的只读任务执行，登记配置不等于节点当前状态。

### 26.3 LLD：中心数据、接口与授权

`runtime/src/operations` 按 website、certificate、compose、backup 分别定义配置校验、公开脱敏表示、动作及输入校验。`server/operations.ts` 统一登记、版本、方案和批准；`server/operation-schedules.ts` 只调度受支持的固定动作。SQLite 新增：

| 表 | 数据与边界 |
| --- | --- |
| `ops_resources` | ID、kind、name、agent_id、revision、加密 config、创建/更新时间与创建者 |
| `ops_runs` | 资源/版本、动作、加密不可变 payload、脱敏 preview、授权者、30 分钟有效期、关联 job 与状态 |
| `ops_schedules` | 资源版本、动作、加密输入、五字段 Cron、IANA 时区、启停、授权者、revision 与停止原因 |
| `ops_schedule_fires` | schedule_id＋UTC slot 唯一去重、计划版本、run_id 与触发结果 |

管理员 API 为 `/api/v1/operations/resources` CRUD、`resources/:id/plans`、`runs` 读取、`runs/:id/approve` 和未领取取消，以及 `/api/v1/operation-schedules` CRUD/运行/历史。修改配置使用 revision 乐观锁，资源执行中拒绝修改。网站须成功停用后才能移除执行过的登记；有变更历史的 Compose 保留登记和历史；证书被网站引用、资源被计划引用时拒绝删除。删除登记不销毁远端数据。

批准事务检查方案未过期、资源版本一致、没有同资源进行中任务，然后幂等创建现有 Agent job。普通 job 只含 operation ID、domain 和 capability；不保存证书私钥、S3 凭据等秘密。Agent 必须以 control 身份和 `X-LightMoni-Job-Lease` 读取 `/api/v1/agents/:id/jobs/:jobId/operations`，中心核对节点、租约/任务有效期、动作、批准与 run/job 关联，响应 `Cache-Control: no-store`。Agent 禁止重定向、限制下载 1,200,000 字节，再核对 operation、node、domain、capability 和期限。

阶段沿用 accepted → staging → activating → verifying → succeeded/failed/unknown。成功要求现场验证与绑定该 operation/resource 的回执；中心不接受错配或没有健康证据的成功。已领取任务不能当作安全取消；租约失联、进程中断或部分修改无法确认时保留 unknown，不自动重放写操作。旧 Agent claim 跳过无法提供 capability 的新任务，避免堵住原有任务。

中心以事务确保同一节点只有一个有效任务租约，但租约失效不能证明旧进程已停止。节点写动作另以持久 `<dataDir>/operations/execution.lock` 的独占创建互斥：正常已知结果释放，unknown 或崩溃保留，不按 PID 消失或超时自动解锁。只读 inspect/logs 不获取写锁，供恢复核查。管理员须先确认旧进程与 Docker daemon 等后端动作停止、检查真实状态，再人工移除锁并批准新的方案；只点击重试或 `acknowledge_unknown` 不能解锁。相同节点身份必须使用同一持久 dataDir，禁止克隆身份到多个独立目录。

### 26.4 LLD：网站与证书

网站配置绑定域名、节点、static/proxy 模式、端口、静态文件或 upstream、可选 certificate_id/service_id。默认 HTTP 8088，HTTPS 8443；不会自动抢占已有 80/443 或修改 1Panel/其他 Nginx。小型静态站最多 200 个 UTF-8 文本文件、总文本 512 KiB，并限制序列化大小；不支持任意宿主目录和 ZIP 上传。HTTPS upstream 默认校验系统 CA，管理员显式关闭时在配置中可见。

Agent 在独占目录生成 Nginx 配置、版本和日志。先校验候选，再原子切换、重载，并请求唯一配置摘要端点验证真正生效；HTTPS 另核对实际 peer 证书指纹。失败尝试恢复上版。restore 指向保存版本，disable 验证停用，logs 按行数和 JSON 字节截断。Agent 启动只恢复已有受管网关，不安装依赖或重写用户网关。每次信号操作核对 PID 对应独占 prefix/config，避免操作其他 Nginx。

Agent 私有数据目录 0700、私钥 0600；root master 的 worker 使用 nobody。公开静态资产和 ACME challenge 独立放入 `/var/lib/lightmoni-web/<数据目录摘要>`，目录 0755、资产 0644，不开放整个 Agent 数据目录。证书公开接口只返回 has_certificate/has_private_key 和元数据；私钥加密传送，节点校验私钥匹配、域名和有效期后安装，展示到期天数与指纹。

ACME 采用 Certbot webroot HTTP 验证，不停止已有 Web 服务。前提是同域名的受管 HTTP 网站已在 80 端口生效、外部 DNS/防火墙可达且 challenge 检查成功。issue/renew 为显式任务，周期续期须单独启用计划。首次签发后需将网站绑定 certificate_id 并 apply；已绑定证书的 install/renew 在替换前核对所有实际绑定网站的域名 SAN，随后重载受管网关并逐站核对新连接的实际 HTTPS 指纹，失败恢复旧文件并验证旧指纹。中心也禁止从证书登记中移除已被网站依赖的域名。证书是共享引用，网站方案固定 certificate_id 和自身配置，不能声称冻结了依赖证书文件的历史指纹。崩溃后自动恢复拒绝未与最后验证状态一致的配置/证书，必须人工检查。DNS challenge、通配符、DNS 托管及公网证书实厂商验收不在已验证范围。

### 26.5 LLD：Docker 与 Compose

管理员先登记项目名和受限 JSON Compose 文档，再 discover/inspect 观察；发现不会获得写权限。支持 1～20 服务、显式 tag/digest 镜像、项目命名卷和网络、受限端口、环境变量、启动参数与健康检查。禁止 latest/无 tag、build、宿主 bind、docker.sock、privileged、host 网络及用户指定 external 卷/驱动。环境值、command/entrypoint、healthcheck.test 在公开配置中遮蔽；编辑默认保留旧密文，替换时提交完整文档，不保存遮蔽占位符。

每个写动作带 `expected_generation`，防止基于旧状态执行。显式接管另要求现场 `inventory_sha256` 和 `acknowledge_recreate`，提醒可能短暂停机；项目名一经登记不可修改。受管文件、资源 label 与节点 registry 共同核对归属；接管已存在卷保留其精确名称和数据，不做卷删除。所有 Docker 调用显式使用 `--context default` 并剥离远程 Docker 环境，避免节点用户保存的 currentContext 把任务发到其他机器。apply/start/stop/restart/rollback 检查真正容器状态与健康，启动过程最多有界等待。配置回退使用历史 generation，只恢复配置，不恢复或删除数据卷，不承诺数据库迁移可逆。部分执行失败保留 pending/unknown；重新收敛须先按 26.3 人工核实并解除节点写锁，再以 `acknowledge_unknown` 批准新的 apply/rollback 方案。

此领域与 SDD 021 的 systemd release bundle 分开：本轮提供受管 Compose 文档生命周期，不声称源码自动构建、任意 YAML 导入、Kubernetes 或跨节点发布已经实现。

### 26.6 LLD：备份与安全恢复

备份面向受管普通文件目录，来源和本地存储必须为绝对路径、不可重叠且拒绝符号链接。Linux 全链路径要求 root 管理、不可被业务用户写入（系统 sticky 临时祖先例外）；不支持活动数据库一致性或不受信用户同时修改目录。默认最多 64 MiB/10,000 文件，可配置上限 256 MiB/20,000 文件。

归档为有界 gzip manifest，包含相对路径、模式、内容和 SHA256。创建后回读校验；本地文件以 resource ID 隔离，S3 采用 SigV4、path-style PUT/GET/LIST/DELETE，限定 bucket/prefix/resource ID，不自动创建云资源。显示归档摘要、源摘要、大小和对象版本（提供者支持时）。修改同一 S3 目标可空填复用密钥，换 endpoint/bucket/region/prefix 必须重填；读取不回显密钥。

恢复带 backup_id 与 `expected_target_sha256`，先验证归档路径/摘要及当前目标 CAS，再创建恢复前副本，最后替换与验证。prune 仅清理超出 retain_count 的常规备份，保留恢复前副本；这些副本需管理员后续单独管理，当前不自动清理。列表和清理回执最多展示 100 条并附总数/截断标记，不缩减实际清理范围；已验证恢复的旧目录清理失败只记录 cleanup_pending，不推翻成功恢复。部分写入或补偿结果不能确认时返回 unknown。文件备份有真实本机验证，S3 协议有独立验签 HTTP 验证；未声称已在 AWS/MinIO 上完成供应商验收。

### 26.7 LLD：调度、运行依赖与验证边界

计划支持五字段 Cron（分钟/小时/日/月/星期）与 IANA 时区，UTC 分钟 slot 持久去重，DST 回拨对应不同 UTC slot；中心错过的分钟跳过、不突发补跑。同一计划不重叠，同一资源审批互斥。配置 revision 变化、授权管理员停用/降权、dispatch 不确定或执行 unknown 时停止计划，管理员显式更新重新授权后才在新 slot 运行。每次触发重查 users.active 与 admin 角色。

首期允许 backup create/verify/prune、certificate renew、website inspect、compose inspect；不开放周期任意 shell、恢复、重启或发布。手动运行也使用相同边界与回执，计划启用表示管理员对固定目标/参数的持续授权，不能由 AI 代为启用。

管理员按需为 Linux Agent 准备 Nginx、OpenSSL、Certbot、Docker 与 Compose plugin；中心不需要 docker.sock，节点不能通过模型生成任意 shell。命令用参数数组、shell:false、超时/取消与合计输出限制，不继承 DOCKER_HOST 或中心秘密环境变量。POSIX 中断会终止整个子进程组，但不能据此认定 Docker daemon 的操作也已撤销，因此未知结果保留持久写锁，恢复步骤见 26.3 和 [运维手册](operations.md)。真实 Linux 隔离验证覆盖网站、反代、TLS 轮换、日志/恢复/停用、Compose 生命周期与配置回退；公网 ACME、S3 供应商、生产并发与大容量继续按验收记录说明。规格、输入契约和证据统一见 [SDD 026](../specs/026-operations-platform/spec.md) 及其 validation 文档。


## 33. 网站、DNS、证书与 Docker 服务托管（SDD 033）

2026-10-29。用户批准整体重构并明确尚未上线、无需旧模型兼容。此章描述 SDD 033 分支实现，合入和真实外部服务验收以对应 PR/validation 为准；第26章的网站、证书与容器描述由本章替代，备份/计划和恢复说明继续适用。

```mermaid
flowchart TB
  ops033_admin["管理员工作台 / 五核心能力"]
  ops033_api["中心资源与策略 API / revision / 持续授权"]
  ops033_db["SQLite + 加密版本 / 资源 / 实例 / 端口 / 执行"]
  ops033_reconcile["领域独立收敛 / 部署 / 续期 / 分发"]
  ops033_cloud["中心云适配器 / DNS / ACME / 三云 CDN"]
  ops033_job["Agent job + 有效 lease / 私有不可变载荷"]
  ops033_agent["独立 Agent / 本机执行 / 持久写锁"]
  ops033_app["Docker / Compose / 应用与托管服务实例"]
  ops033_gateway["OpenResty host 网关 / 多路径 / 静态 / 服务入口"]
  ops033_target["证书目录 / 更新脚本 / 版本去重 / 显式环境"]
  ops033_receipt["现场状态与有界回执 / 健康 / 指纹 / 负载 / unknown"]
  ops033_admin -->|配置与人工确认| ops033_api
  ops033_api -->|加密状态| ops033_db
  ops033_api -->|授权策略| ops033_reconcile
  ops033_reconcile -->|中心签名请求| ops033_cloud
  ops033_reconcile -->|派发| ops033_job
  ops033_job -->|control + lease| ops033_agent
  ops033_agent -->|部署 / 探活| ops033_app
  ops033_agent -->|完整版本包| ops033_gateway
  ops033_agent -->|材料与脚本| ops033_target
  ops033_gateway -->|健康 IP + 端口| ops033_app
  ops033_app -->|状态 / 负载| ops033_receipt
  ops033_gateway -->|HTTP / TLS| ops033_receipt
  ops033_target -->|逐目标结果| ops033_receipt
  ops033_receipt -->|绑定回执| ops033_api
```

### 33.1 组件职责与资源模型

中心仍是 Node.js/TypeScript 模块化单体，SQLite 保存管理状态，ClickHouse 保存遥测；未引入 Consul、Kubernetes、第二个中心或中心 Docker socket。runtime/src/ops 统一全局 credential、dns_zone、acme_account、certificate、certificate_target、application、service、node_pool、gateway_group、website。应用描述 Docker 单容器或 Compose 声明；部署/实例绑定机器；托管服务声明资源、副本和端口；网站声明域名、HTTPS 与静态/反代/服务目标。OpenResty 是 host Docker 系统应用，多网站共享网关组内的进程。

### 33.2 存储、版本与执行

ops_platform_resources 保存 revision、加密 spec、脱敏 status 和授权者；ops_platform_revisions 保存不可变配置快照；ops_platform_runs 保存加密请求快照/输入、逻辑去重键、执行状态和脱敏结果。ops_platform_instances、ops_platform_ports 保存实例、资源与端口预留；ops_platform_nodes 保存 Agent 只读容量观察。证书版本、ACME 账号/订单/挑战、DNS 观察/归属及云证书映射分别持久保存。配置保存与应用发布分开；发布冻结 desired_revision，托管服务同时冻结 application_revision 和 node_pool_revision。新配置需显式发布才进入持续维护。

### 33.3 鉴权、私有载荷与调度

管理员 API 为 /api/v1/ops，统一 revision、confirmed、资源引用和可用动作检查。人工动作和已启用的持续策略记录授权者，每次新派发重查管理员有效性。领域各自维护 in-flight，慢 DNS/ACME 不阻塞工作负载轮次；网站 DNS 刷新另有并发上限。新 Agent 动作使用 operations.platform，复用现有 control 身份、job lease 和 /agents/:id/jobs/:jobId/operations 私有下载；普通 job 仅含 ID。成功回执必须匹配 operation/resource/node 并有现场验证；中心拒绝陈旧或撤权载荷。关闭时拒绝新动作，等待已开始的领域/云动作再关闭存储。

### 33.4 DNS 与 ACME

阿里 DNS 与 DNSPod 通过固定官方 HTTPS 端点签名请求，支持全量分页 CRUD/启停和管理 scope；五分钟有界只读同步观察外部修改。人工可管理授权范围内记录，网站/ACME 自动化只维护已记录归属和 Record ID 的记录。API 接受、平台回读和公网传播是不同状态。ACME 在中心使用持久账号密钥、订单、CSR 和 DNS-01 挑战，精确创建/清理本订单 TXT，支持同名多值与通配符；不把 DNS 凭据下发到网关。

### 33.5 证书版本与三类分发目标

证书支持 ACME、上传、自签；公私钥匹配、SAN、有效期和指纹均校验。材料与不可变版本加密保存，公开接口只显示元数据和 has_*。上传证书只能提醒到期；ACME/自签可显式启用自动续期，窗口按实际有效期计算，尚未接入 ARI；失败续期可人工重新 issue/renew，不宣称完整自动退避已实现。网站首次发布 HTTPS 时，材料缺失或过期可调用中心证书签发后继续部署。证书目标分别为 Agent 目录、云 CDN、更新脚本，各自记录 desired/applied 版本与结果。

### 33.6 云服务、脚本与凭据边界

首批云目标覆盖阿里云、腾讯云、火山引擎 CDN HTTPS 域名。阿里 CDN 直接部署 PEM；腾讯 SSL 上传后更新 CDN；火山证书中心上传后部署 CDN。云映射保留远端证书ID，上传/绑定/逐域回读分别核实；HTTP 200、上传成功或某一域成功不替代全部目标生效。云凭据、ACME 密钥只由中心加密使用。目录按受管版本落盘并切换指针，私钥权限受限。更新脚本由管理员固定 Agent、解释器、正文、显式环境和超时；正文与环境加密，不在普通摘要回显，也不送 AI。脚本通过证书临时文件路径及版本元数据获得材料，具有 Agent 本机权限，无沙箱承诺。

### 33.7 幂等、未知结果与恢复

证书目标按目标修订＋证书版本持久去重，云上传复用已保存远端ID。unknown 不自动重放任意脚本或不确定写入；inspect 可只读核对云配置、目录指纹或脚本成功标记，未核实的 unknown 不允许 retry。核对目标不会自动清理节点持久 unknown 写锁，旧进程/daemon和现场状态仍需管理员核查。回执和错误只保存安全码、ID及有界摘要，不返回私钥、脚本环境或任意 stdout/stderr。历史中心 verifying 表示等待读回，不作为永久编辑忙锁；真正执行中的中心动作和活动 Agent lease 才阻止冲突编辑。

### 33.8 Docker 应用与轻量调度

Agent 使用本机固定 Docker context 执行单容器/Compose。平台管理配置文件、只首次写入的初始化文件、数据目录和 Docker volume；停止/移除容器不删除业务数据。资源和端口在 SQLite 事务预留，实际端口在节点复核。机器池可显式设置容量，也可经 node.inspect 获取 CPU/内存/IP/Docker 能力。调度基于在线机器、容量、端口与副本分散；现有副本按健康回执逐个更新，健康连续失败时有界重建。服务发现提供新鲜健康实例的机器可达 IP＋发布端口，要求机器之间已有可达网络；没有自动 overlay 或本地数据复制。

### 33.9 网站、网关与流量

网站支持静态文本文件、手工 HTTP(S) 反代和托管服务。网站仅在显式启用后进入网关完整版本包；域名在组内唯一。Agent 按版本暂存站点/证书/静态文件，检查 OpenResty 配置后切换、重载并实际验证 HTTP 内容与 TLS 指纹，失败恢复旧版。服务路径无健康后端时仅该路径返回503；多路径与Nginx可配置能力见33.11，端点变化重编译对应上游。网关在 Linux host 网络直接监听端口；已验证健康网关的公网地址进入平台拥有的 A/AAAA，关闭网站移除自身拥有记录。DNS TTL 不提供即时故障切换保证。Agent 失联不等于容器停止，不据此释放端口或静默迁移本地数据。

### 33.10 界面、验证与支持范围

网站与运维提供五核心页签和共享基础设施，应用/服务列表显示机器和现场负载，证书显示到期和逐目标结果，表单支持中英文/主题/窄屏、失败保留输入。旧 /services 用户入口转向托管服务。代码验证覆盖 SQLite/HTTP/有效 Agent 租约、真实自签/目录/脚本、协议签名/分页/ACME 生命周期及调度故障；真实 Linux Docker/Compose/OpenResty 与 UI 夹具和实际 SQLite 页面验收分别记录。真实云账号/CDN边缘传播、公网 ACME 发证和大规模生产负载未获现场验收，不由夹具代替。详见 specs/033-operations-control-plane/validation.md 和 docs/operations-platform.md。

### 33.11 Nginx多路径与站点配置

网站配置新增 nginx 站点设置与 locations 路径规则，作为加密不可变网站版本保存。中心与 Agent 共用 runtime/src/operations/nginx.ts 校验与编译；中心在组包时将每条托管服务路径解析成新鲜健康端点，只有无后端的对应路径返回503。支持精确、最长前缀、^~ 与有序正则匹配；独立上游及加权轮询/最少连接/IP哈希、URI保留/去前缀/替换、Host/SNI与TLS校验、WebSocket、超时/缓冲、请求与响应头、CORS及OPTIONS、访问控制、上传和速率/连接限制。站点提供HTTPS跳转/HTTP2/TLS、Gzip、静态索引/SPA/缓存和日志。反代缓存使用各站点路径独立临时区域，默认绕过Authorization、Cookie与升级请求。server/location补充片段按词法边界限制上下文，拒绝include、动态脚本和全局/文件越界指令；其他语法由真实nginx -t验证，失败保留活动版本。管理员 GET /api/v1/ops/resources/:id/nginx 提供保存修订的脱敏预览，隐藏自定义片段和敏感头值，只展示证书占位路径，不读取PEM、不部署、不声称现场已验证。控制/租约及完整版本检查、切换、HTTP/TLS回执通路不变。

## 第42章 集群与应用统一部署（SDD 042）

2026-10-30。本章描述codex/042-cluster-applications最终跨集群首版，替代第33章独立机器池、托管服务、网关组及单集群应用/网站模型。第33章DNS、ACME、证书、云分发、脚本和执行安全边界继续适用。分支实现与验证记录以SDD042为准，不声称已合入main。

```mermaid
flowchart TB
  template["商店模板 / 自定义程序"] --> app["全局应用 / 唯一serviceName"]
  app --> a["集群A部署 / 实例数与大小"]
  app --> b["集群B部署 / 实例数与大小"]
  site["网站公共配置 / 域名 HTTPS 超时"] --> resty["各集群OpenResty / host80+443 可托管"]
  resty --> local["仅本集群健康服务 / 命名端口"]
  resty --> dns["网站CNAME / 线路与权重 / 集群稳定入口域名"]
```

### 42.1 集群与稳定机器归属

公开运行资源为cluster、全局application和全局website。一台稳定managed_machines.id只属于一个cluster，ops_platform_cluster_members以machine_id主键在资源保存事务内约束唯一。Agent重装不改变归属；agents.group_id继续表示采集标签。运行实例使用中的机器不能直接移出，仍属集群的主机不能从主机目录删除，非空集群不能删除。

### 42.2 全局应用与集群部署

商店模板或自定义镜像/Compose生成普通application，一份模板可安装多套独立应用。name为可重复展示名；service_name全局唯一且创建后不可改，默认模板英文标识加序号，小写字母/数字/短横线、首尾字母数字、最长63字符。应用共享运行配置、命名端口与manual/managed模式；deployments按cluster分别设置手动机器或托管实例数、每实例CPU/内存。持久部署状态以application_id+cluster_id为键分别冻结发布修订和授权者，一处发布不升级另一处草稿。

### 42.3 实例、端口与发现

ops_cluster_instances显式保存cluster_id，活跃slot按owner+cluster唯一，退役attempt保留到原节点确认清理。ops_platform_instance_ports保存每实例全部命名端口，ops_platform_ports提供宿主协议/端口排他预留。manual不自动换机或补副本；managed仅在对应集群选择满足容量和全部端口的机器。两种模式均支持固定host_port，冲突不能改号；中心排除已知占用，Agent现场复核，已知占用失败退避该候选并选择其他机器，无候选待调度。serviceName+cluster_id+port_name只返回新鲜健康端点，网站严格当前集群发现，无跨地域隐式兜底。

### 42.4 OpenResty托管与完整配置

OpenResty是role=openresty的全局唯一应用，可部署多个集群，每集群一项部署。已安装应用可编辑部署集群、机器、副本和资源；运行中的部署先停用清理再移除。每个入口部署保存稳定gateway_domain，可选gateway_dns_zone_id托管健康入口A/AAAA；未选择时由用户维护。manual选择机器，managed设置实例数和资源；Linux host网络固定80/443。内部gateway.apply/inspect/stop/remove复用Agent执行器，owner仍为application。每集群完整网站、证书和静态文件包逐机nginx -t、切换、重载、HTTP/TLS验证；失败保留旧版。故障换机完成配置与验证后恢复DNS资格。

### 42.5 网站公共配置与集群上游

website为全局对象，bindings统一域名、HTTPS、证书、DNS，nginx及locations统一路径、超时、头部、缓存、限流和其他高级选项。routing_mode=managed时选择一次service_application_id和HTTP(S)命名service_port_name，自动发现其部署集群，集群内只解析该服务的健康端点。manual保留locations.cluster_targets逐集群应用端口或代理URL；不支持公共配置覆盖。集群流量策略cluster_policies保存enabled、1–100相对weight、default及厂商线路id/name，独立于冻结网站公共修订；关闭立即退出期望解析，恢复仍需成功回执。公共草稿不能通过流量策略保存被隐式发布。

### 42.6 DNS聚合、共享资源与界面

DNS/ACME账号、托管域名、证书和分发目标保持中心加密共享，凭据不下发网关。新网站dns_record_mode=cname，网站以自身为owner，按默认和高级运营商/省份线路维护到各集群gateway_domain的加权CNAME；只包含开启、已发布且有新鲜健康入口和成功网站回执的集群，托管服务还须有健康后端。默认所有集群1:1，失效集群在默认与高级线路中撤下，细分线路无目标由厂商回退默认。可选集群入口A/AAAA以全局OpenResty应用为owner维护。旧address模式保留A/AAAA兼容。只修改自身归属记录；线路纳入身份，权重/TTL/状态必须回读。厂商可用线路查询后预检，拒绝不支持套餐或权重，API接受与缓存传播分开。网站页面主体展示用户网站、域名及实际集群、开关、权重、线路与错误；OpenResty部署集群和入口域名收于次要的“OpenResty 管理”抽屉。

### 42.7 控制与兼容边界

中心继续Node/TypeScript+SQLite；cluster-workloads由原workloads组合装配，原加密资源/修订/执行、Agent control凭据和有效job lease保持不变。配置/发布/持续策略由管理员授权，AI不批准或任意执行，生产中心无Docker socket。旧单cluster application/website规范化为deployments和cluster_targets单项，保留资源ID、serviceName、实例ID、数据路径及运行容器；legacy node_pool/service/gateway_group保留历史，不提供新建与新部署。首版商店内置MySQL/Redis/OpenResty，自定义程序通过镜像/Compose发布，源码CI与第三方商店源后续扩展。

### 42.8 现场验证与范围

Demo使用真实SQLite/HTTP、Agent enrollment与有效lease、生产执行器、Docker、MySQL、自定义Web双端口和OpenResty，覆盖网站读写、TLS、Web重建数据保留以及托管入口。多节点QA如使用DinD，明确其为同一物理Docker宿主上的独立daemon/网络命名空间，不冒称多地域实机。测试域Host替代公网DNS、自签证书替代公有CA；DNS聚合协议另行mock验证，不声称公网传播或ACME已验。具体通过项、未验范围和可复现命令见SDD042 validation及examples/cluster-demo/README.md。

### 42.9 网站多集群入口与线路流量管理（SDD 043）

2026-10-30。以上42.4至42.6按SDD043演进。托管网站跟随最近授权发布修订的服务部署新增/移除集群；公共草稿不驱动线上切换。DNS归属日志增量保存line和weight；同值不同线路独立归属，外部修改、未知写入与授权撤销保持保护。阿里云CNAME权重部分接口文档与产品说明有差异，必须实际请求接受且回读权重策略；DNSPod活动权重只使用1–100，0不表示停用。失败不静默回退或冒称成功。域名套餐、省份/运营商线路和缓存传播依赖厂商能力；当前验证用HTTP/SQLite/Agent租约与DNS协议夹具，不声称真实云套餐或公网传播已验。

```mermaid
flowchart LR
  site[网站域名] --> default[默认线路 / 健康集群按权重]
  site --> special[省份与运营商线路 / 无目标回退默认]
  default -->|CNAME 1| south[南方集群稳定域名]
  default -->|CNAME 1| north[北方集群稳定域名]
  special -->|CNAME| south
  south --> southIP[健康南方入口 A / AAAA / OpenResty 80+443]
  north --> northIP[健康北方入口 A / AAAA / OpenResty 80+443]
  health[中心：开关 / 健康 / 成功回执] -->|维护| default
  health -->|维护| special
```

具体规格、数据字段、契约、厂商官方资料与验收记录见[SDD 043](../specs/043-website-cluster-routing/spec.md)。
