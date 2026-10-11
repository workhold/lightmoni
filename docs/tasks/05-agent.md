# 05 · Go Agent

状态：开发基线，2026-10-10。本文保留任务约束，下列实现状态单独列出。遵循 [产品约束](../brief.md)、[整体方案](../architecture.md) 和 [公共契约](../contracts.md)；公共接口由主干统一维护。

## 当前实现与验证

- 已提供 Go Agent CLI、标准 OTLP/HTTP Protobuf/JSON 接收、固定资源 enrichment、SQLite WAL/FULL 队列与 receipt、全局 Key 转发、网络退避、quarantine/显式处理、注册/心跳/配置缓存，以及共享 Go SDK 的主机/指定进程和 HTTP GET/TCP 拨测。标准 OTLP JSON 的 hex trace/span ID 转为内部 Protobuf，保留关联身份。
- 一个 Agent 配置一个上报 Key，覆盖其获授权 table 内的任意 service；Key 不绑定或区分 service。SDK 自有批次仍限制单 service，外部兼容批次可含多个 service。资源实际属性为 `host.id`、`lightmoni.agent_id`，存储列由主干映射为 host_id/agent_id。
- 初始解压/转发上限 4 MiB，payload 队列 256 MiB/10,000 批，receipt 100,000 条/48 小时，补传窗口 24 小时，预留磁盘 32 MiB；支持配置。receipt 满时背压而非提前删除；quarantine 占用同一有界队列。HTTP/TCP 每任务有超时，最多 16 并发，重叠/拥塞跳过可见。
- `go test -race ./internal/agent ./cmd/lightmoni-agent` 已通过，覆盖真实本机采集、指定当前进程、多维指标经 SDK 进持久队列、两 service 共用 Key、Key 切换不改 payload、receipt 重启/已完成重试、存储故障/容量背压、网络 ACK 丢失、永久错误 quarantine、标准 JSON trace 关联、控制流程、HTTP/TCP 和无效配置保护。
- 已提供固定版本 Linux amd64/arm64 发布脚本、校验和安装器、systemd unit 与离线卸载脚本，shell 语法检查通过。真实 Linux 安装/掉电/物理满盘及 ClickHouse 端到端验收须由集成环境执行；进程重启与模拟存储错误不当作掉电证明。

接入、发布与故障操作见 [Agent 示例](../../examples/agent/README.md)。

## 目标与范围

交付一个可安装为系统服务的 Go 程序，让同一台机器的多个业务服务共用 Agent 和实例上报 Key。Agent 接收 SDK 数据、采集机器与指定进程状态、发起 HTTP/TCP 拨测，统一经磁盘队列发送到主服务。用户不创建项目，不为每个 service 配置 Key。

首批目标为 Linux amd64/arm64 与 systemd。机器采集和拨测嵌入任务 04 的 Go SDK，共用 log/metric/trace 模型；内置 exporter 直接调用持久化队列入口，不能发送到自己的 HTTP 接口形成递归。主服务提供 Agent 页面、注册、心跳、配置和拨测计划；Agent 任务只实现其客户端与执行逻辑。

首版不交付远程任意命令执行、自动升级、完整容器编排管理、全量进程巡检或跨操作系统同等支持。业务 SDK 日志接收属于首版；目录文件 tail、rotation/offset 与 SQLite 原子检查点已按新增需求实现，仍需独立验证文件采集路径。

## 代码所有权

| Agent 可修改 | 用途 |
| --- | --- |
| `cmd/lightmoni-agent` | 程序入口、生命周期、命令行 |
| `internal/agent` | 接收、资源补充、队列、上报、主机采集、进程采集、拨测、控制客户端 |
| `deploy/agent` | 安装/卸载脚本、systemd unit、配置示例、发布校验说明 |
| `examples/agent` | 多服务共享 Agent、容器连接与断网恢复示例 |

`sdk/go` 属于 SDK 任务；`api`、主服务注册和查询接口、ClickHouse 去重属于主干；共享前端与 Agent 管理页由主干实现。Agent 可以提出接口修改，不能另建一套指标 SDK、公共类型或认证模型。

## SDK 接收与批次身份

- 本地 OTLP/HTTP 入口遵循公共契约的 `/v1/logs`、`/v1/metrics`、`/v1/traces`，解析标准 Protobuf 与约定 JSON 编码，限制压缩前后大小。默认 `127.0.0.1:4318`；主服务私有 Key 只存 Agent 配置。
- 一个冻结批次只有一个 signal 与一个业务 table；`X-Lightmoni-Table` 传业务名，资源中的 `service.name` 标识服务。指标按类型路由由主干处理，Agent 不自行拼接 ClickHouse 物理表名。
- 自有 SDK 每个冻结批次提供稳定 UUID `X-Lightmoni-Batch-ID`。同 ID 重试必须保持同原始 payload、时间和路由。Agent 校验输入摘要；ID 冲突且内容不同是明确协议错误，不能当作成功重复接收。
- 接收时补充安装期间固定的 `host_id`、`agent_id`，不覆盖业务 `service.name`、实例标识、trace/span ID 或事件时间。动态主机属性由主机采集通道报告，不能在批次每次重试时重新补充。
- 补充资源后冻结转发 payload；同一批次不在 Agent 重新聚合、不合并成另一批次，不把 Counter Delta 改为累积值。可并发发送不同批次，但每个批次的内容保持不变。
- 无稳定批次 ID 的外部 OTLP exporter 可走兼容接入路径；Agent 首次接收可分配转发 ID，但无法判断其 SDK 级重试是否重复。界面与文档必须说明该路径没有自有 SDK 的完整幂等保证。
- 容器内 `127.0.0.1` 指容器自身。示例提供宿主网络、受限宿主地址或 sidecar 的明确接法。需要跨容器暴露时由用户显式配置监听地址与本地接入限制；不能默认为全网开放，也不能把主服务私有 Key 分发给每个业务容器。

## 持久化队列与确认边界

首版采用进程内、磁盘支持的队列，不增加消息队列服务。实现前冻结队列接口与存储格式版本；可以复用经过维护的嵌入式存储库，必须验证其同步提交语义。以下约束对任何实现相同。

1. 验证整个批次、路由和容量后，将 batch ID、输入摘要、冻结转发内容、固定 enrichment、首次接收时间和队列元信息作为可恢复记录提交。
2. 只有同步持久化成功，Agent 才向 SDK 返回协议成功。文件实现须验证文件及目录持久化顺序；数据库实现须明确事务和同步配置。写入内存、调用返回或操作系统缓存不能直接视为这个 ACK 边界。
3. 出口从已提交队列读取原内容，使用同一实例上报 Key 发送；只有主服务对整个批次返回 ClickHouse 持久写入成功，才将队列记录标记已完成并回收数据。主服务部分写入、响应丢失与超时均不能提前删除。
4. 若 Agent 的 ACK 丢失，SDK 重试可能发生在该批次已转发完成之后。保留覆盖主干幂等窗口的有界 receipt 元信息，校验输入摘要并复用首次 enrichment；重试不能产生另一份 payload。窗口外行为由契约明确，不能承诺无限历史去重。
5. 启动扫描/恢复只重放完整提交记录。截断、损坏、缺失记录进入可见故障状态，不能跳过后仍报告队列全部健康。格式升级须有版本校验与失败保护。
6. 队列按字节与记录数双重限制，并预留磁盘空间；默认满队列拒绝新批次，返回可重试背压。不能先 ACK 再因为满盘删除旧数据。清理已确认记录也失败时报告状态，不以重复接收来无限膨胀。
7. 对已 ACK 的批次，永久校验错误、过期补传等转入有界 quarantine 或经明确配置执行终止处理，记录 batch ID、数量和原因。quarantine 满时继续背压；不能将永久失败隐藏在正常已完成状态。认证错误属于需修复配置的暂停状态，不把缓存自动清空。

传输为至少一次。主干负责稳定记录 ID 与查询去重；Agent 的磁盘队列本身不能保证端到端计数只出现一次。重试状态机按 [OTLP 规范](https://opentelemetry.io/docs/specs/otlp/) 实现：可重试 HTTP 429/502/503/504 或连接/响应丢失，尊重 `Retry-After`，否则指数退避并加入随机抖动；永久错误和 partial-success 的处理须按公共契约区分。不能把所有 HTTP 5xx 一律无限重试。

SDK 在 Agent durable ACK 之前仍保留有界内存批次；业务进程在此之前崩溃可能丢失。Agent 本地磁盘损坏也不属于可恢复断网保证，状态页需准确表述边界。持久发送队列与重启恢复的参考是 [OpenTelemetry Collector resiliency](https://opentelemetry.io/docs/collector/resiliency/)，LightMoni 仍需验证自己的 ACK 与容量策略。

## 主机与进程采集

| 数据 | 首版模型与要求 |
| --- | --- |
| CPU | 总体使用率 Gauge；计算使用采样间隔，首个基线样本不可伪造为正常 0 |
| 内存/Swap | 已用、可用/总量 bytes Gauge，明确字段含义 |
| 文件系统 | 使用/总量 bytes Gauge，维度为受限挂载点/文件系统；排除配置可调整 |
| 磁盘与网络 I/O | 从宿主累计值计算有效 Delta，再调用 SDK Counter；识别重启/重置，不发负增量 |
| 主机状态 | uptime、load 等 Gauge；支持情况进入状态，不把采集失败当零值 |
| 指定进程 | 按用户配置的服务/进程匹配器采集存活、CPU、RSS、线程/FD 等可用指标；权限不足单独显示 |

主机默认 `service=lightmoni-agent`、`table=host`。进程采集的名字、类型、单位、维度与重置语义写入 SDK 共用指标目录；可以复用 [gopsutil 上游库](https://github.com/shirou/gopsutil) 的 CPU、内存、磁盘、网络与进程 API，依赖版本由主干锁定。也可参考 [OTel hostmetrics receiver](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/receiver/hostmetricsreceiver/README.md) 的可选采集项，但不要为此默认引入完整 Collector 运行进程。

限定被监控进程数和属性基数，不默认以所有 PID/完整命令行构建无限序列。进程身份需结合 PID 和启动信息识别重用；权限不足、进程消失与存活 0 区分。命令行可含秘密，默认不上传。主机采集失败不影响 SDK 接收和其他 collector。

Agent 自身重启后的 CPU/网络基线重新建立，保留 Gauge 观测时间和 Counter 窗口；不能为断网期间未采样的数据补造历史点。采集周期与出口 flush 周期分别配置。

## HTTP/TCP 拨测

- 主服务保存任务并分配给 Agent，Agent 缓存最后一次验证通过的配置，断网期间继续已有任务。每份计划有 revision，更新原子替换；错误计划维持旧配置并上报原因。
- 当前 HTTP 支持 URL、GET、期望状态、超时、TLS 验证和最多 5 次重定向。HEAD/自定义请求头可以后续按 typed 配置扩展；不接受执行脚本。TCP 支持 host/port 与连接超时。
- 定时器限制并发，单任务不得重叠无限排队；超时取消底层请求，配置删除后停止新执行。记录实际开始时间和耗时，超时、DNS、TLS、状态不符分别归类。
- 默认 `table=probe`，走同一 Go SDK：成功状态 Gauge、尝试/失败 Counter、耗时 Histogram。属性仅包含 probe ID、类型和受限结果枚举；URL 中的 token、请求头凭证与响应正文不能成为指标维度或自监控日志。
- 定时抖动、调度跳过与执行错误可见；跳过执行不伪造为一次成功/失败。服务不可达的告警由主服务基于拨测数据求值，Agent 不另建通知引擎。

## 主服务依赖与本地状态

主干提供以下能力，最终路径与类型以公共契约为准；Agent 不自行实现服务器端接口。

| 能力 | 必需字段/语义 |
| --- | --- |
| 注册 | 稳定 agent/host 身份、版本、系统/架构、能力；使用实例 write Key；同身份重试幂等 |
| 心跳 | 上次成功上报、配置 revision、队列 bytes/批次数/最旧年龄、出口/磁盘/collector 状态；主服务用接收时间计算失联 |
| 配置轮询 | revision/ETag、采集周期、匹配器、拨测计划和超时/并发上限；空更新不重启采集器 |
| 接收确认 | 整个 frozen batch 成功持久写入的协议响应；永久失败原因与过期窗口 |

控制请求不经过业务 spool，避免满队列阻止状态报告；控制网络断开时只能从主服务的 last-seen 与本地状态识别故障。不可因控制重试反复注册新身份。收到非法远程配置不覆盖启动 endpoint、私有 Key 或允许范围外的本地路径。

本地 loopback 健康/状态入口与结构化本地日志显示：队列容量、积压年龄、退避、最后成功、永久失败/quarantine、各 collector 状态、配置版本。秘密必须脱敏。对主服务的 Agent 自监控也走共享 SDK，维度不能包含 batch ID。队列坏掉时仍有本地诊断入口，不能靠故障队列报告队列故障。

## 安装、配置与卸载

- 交付固定发布版本的 Linux amd64/arm64 二进制、校验和清单、脚本和配置模板；安装页面生成有版本的下载地址。下载到临时目录、校验后原子替换，不能直接执行无法检查的浮动 latest 文件。
- 安装器识别系统/架构/systemd、写入配置并安装 unit；私有 Key 不作为默认命令行参数暴露在进程列表或 shell history，采用受限配置文件或标准输入。建议配置文件 `0600`，数据目录仅服务账号可写。
- 使用专用服务账号，授予可读取的主机指标能力；单个进程权限不足须降级报告。不得默认启动任意远程命令或为进程采集开放全部主机写权限。
- systemd unit 配置启动、失败重启与停止超时；停止时拒绝新接收，结束采集，尽力 flush SDK，再保留未发 spool。服务自动重启行为按 [systemd 官方文档](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html) 校验。
- 重装保留身份、已有 Key、用户配置与 spool；显式 upgrade 不无条件覆盖本地配置。出现目录冲突、未知格式、校验失败时停止且维持旧程序。
- 提供前台运行、配置校验、状态和本地卸载命令。无网络也能停用并卸载程序；默认保留配置/spool，删除数据需显式参数并说明后果。卸载后主服务通过 last-seen 标记离线，不伪造成功远程注销。

## 阶段与依赖

| 阶段 | 交付 | 依赖/并行方式 |
| --- | --- | --- |
| A：最小协议链路 | 接收标准 fixture、持久队列接口、固定 batch 转发、ACK 故障注入 | 依赖主干冻结 ingest 与 ID 语义；可先用 SDK fixture/假主服务 |
| B：共用 SDK 采集 | 内嵌 exporter、主机/指定进程目录、HTTP/TCP 拨测 | 依赖 SDK 的批次/聚合/exporter 接口；collector/probe 可用 fake exporter 并行开发 |
| C：控制与发布 | 注册/心跳/配置缓存、身份恢复、systemd 安装卸载、示例 | 与主干 Agent 页面和控制 API 联调；不自行改共享 API |
| D：真实故障集成 | 丢 ACK、断网、重启、满盘、永久错误、干净 Linux 安装 | SDK、Agent、主干 ClickHouse 去重必须一起验收 |

不把 B/C 完成作为 A 的持久化正确性证明。先通过批次联调，再扩展 collector；进程匹配与安装脚本可独立推进。

## 验收标准

1. 同机启动两个 service，共用一个 Agent 和一个实例 Key，分别发送日志和多维 Counter。SDK 配置只含 service/table/本机 endpoint；服务端可分别筛选、合并查询，业务 Delta 不被二次累计。
2. 在 durable commit 前杀 Agent：SDK 未得到 ACK，重启后重试。commit 后但 ACK 前杀 Agent：恢复后批次可转发，重复接收不增加逻辑记录。用故障注入证明两个边界，不能只做优雅退出。
3. 主服务已写 ClickHouse 但其 ACK 丢失；Agent 重发相同 bytes/ID。SDK 的 ACK 丢失且 Agent 已回收 spool 后再重试。两种情形均保持 payload、enrichment 和查询计数正确。
4. 断开出口，发送日志和两个属性组合的计数；重启 Agent 后补传，保留事件时间和 Counter 窗口。数据到达后每个维度的总数与发送量一致。
5. 制造队列限额、真实磁盘满与 fsync/事务失败，Agent 不返回成功接收；SDK 有界缓存/丢弃计数可见，旧的已 ACK 数据不因新数据到来被静默删除。
6. 队列中出现永久错误、认证失败与过期补传：各自状态和操作路径明确，不无限占用正常发送 worker，不虚报已送达；quarantine 限额行为可验证。
7. 单 collector 超时/无权限不阻塞 SDK 接收。CPU 首样本、网络累计计数重置、PID 重用均验证无伪零/负 Delta/错误身份；host 与 probe 指标可由主干普通 metric 查询展示。
8. HTTP/TCP 使用本地测试端点验证正常、超时、DNS/TLS/状态不符、任务删除和配置错误。请求取消后无泄漏；最大并发与跳过计数符合配置。
9. Linux 两架构完成安装、重装、停止启动、断网卸载与 spool 保留流程。脚本校验失败不替换现有二进制；默认监听 loopback，Key 不出现在安装输出、进程参数或心跳。
10. 实测空闲、采集和断网积压时 CPU/内存/磁盘占用并记录环境与负载。数值用于主干发布资源建议，任务书不预先宣称毫秒级延迟或固定内存。

## 主干必须冻结的五项

1. Batch ID/输入摘要/转发摘要、资源补充字段、receipt 与主服务幂等窗口、窗口外重试语义。
2. durable ACK 的协议成功条件，以及背压、认证、永久错误、partial-success、过期补传的机器可读分类。
3. Go SDK 进程内 exporter 接口、Counter Delta/Histogram 窗口与内置指标名称/单位/维度目录。
4. 注册/心跳/配置 revision 接口、Agent/host 身份持久化与重装规则、拨测计划 schema。
5. 接收体/队列/quarantine 的默认上限、离线保留/人工终止策略，以及发布版本/校验清单的生成来源。
