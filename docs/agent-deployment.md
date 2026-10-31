# LightMoni Agent 部署与恢复

本文说明当前主机管理部署流程及恢复边界。主机是唯一资产，LightMoni Agent 是主机的管理通道：必须先登记主机，再由平台通过 SSH 预检、审阅确认并安装。每台 Linux 主机最多关联一个独立 systemd Agent，使用专用非 root 用户和持久状态目录，不随业务应用启停。SDK 可以独立直报中心，安装 Agent 不是 SDK 的前置条件。当前接入契约见 [SDD 038](../specs/038-registered-host-agent-onboarding/spec.md)。

以下是早期安装器的历史验收，不代表 SDD 038 主机预绑定流程已完成实机验收。2026-10-27 已用修复安装器与线上 0.1.0 包完成一次 Linux amd64 systemd 首装、真实 enrollment、非 root 运行、配置同步和主机指标入库验收，见 [实机记录](../specs/024-agent-install-startup-fix/validation.md)。2026-10-28 另在本机 Colima 的 Ubuntu arm64、glibc 2.39、systemd 255.4 隔离环境中，使用已发布 0.1.0 arm64 包和当前安装/卸载脚本完成 8 项真实验收：非 root 服务运行、OTLP 日志入队、卸载后程序及 unit 移除、配置和身份 SHA 不变、待上报批次保留，见 [SDD 032 systemd 报告](../specs/032-agent-install-uninstall/systemd-report.json)。这次 arm64 测试使用离线合成身份和不可用的本机 endpoint，不覆盖生产 enrollment 或平台凭据撤销；后两者需分别看真实平台验收与隔离 API 测试证据。

2026-10-30，SDD 045 在本机隔离的 Debian 12 / arm64 / systemd 252 环境完成 9 组真实升级与回退验收，覆盖旧 0.1.0 升级、同版本不同构建、主动回退、启动失败及确认超时自动恢复，非空待上报队列保留，以及审批后运行状态变化拒绝，见 [SDD 045 验收](../specs/045-agent-lifecycle-updates/validation.md)。中心为接收真实 Agent 心跳/配置的 HTTP fixture；平台审批、票据和编排另由真实 SQLite/HTTP 集成测试覆盖。双架构发行物均已构建并校验官方 Node 摘要及 ELF 架构，amd64 真实升级/回退、amd64 真实卸载及独立 Agent 发布容器仍未验收。命令 shim 测试与 arm64 隔离结果不能等同于 Linux 双架构全场景验收。参见 [迁移验收边界](../specs/007-node-runtime-migration/agent-validation.md)。

## 当前支持范围

| 项目 | 当前能力 |
| --- | --- |
| 主机 | Linux amd64/arm64、systemd、glibc ≥ 2.28；安装需要 root，常态运行专用用户 |
| 运行时 | 发行包自带 Node 24.15.0、应用及生产依赖，目标机器不用另装 Node/npm |
| 数据 | 主机/进程指标、HTTP/TCP 拨测、授权目录日志、独立采集与持久上报 |
| 中心连接 | Agent 主动注册/心跳/拉取配置与上报；不需要中心入站连接 Agent |
| 本地诊断 | 默认 `127.0.0.1:4318`，仅 `/healthz`、`/status`；不接收 SDK 遥测 |
| 容器 | 现有 Compose 和 server Dockerfile 部署中心；尚无独立 Agent 发布镜像或已验收宿主采集容器 |

不支持把 Linux glibc 发行包直接用于 Alpine/musl。采集任务使用结构化主机/拨测/日志配置；运维任务通过中心授权和审批执行已支持的受限能力，不提供 AI 任意远程 shell。

## 准备与安装

### 登记主机后由平台安装

管理员打开“主机管理 → 登记主机”，同一表单立即展示名称、中心可达的 SSH 目标地址、端口、登录用户名、登录方式、对应秘密及保存时长。默认使用密码登录，密码和 SSH 私钥共用保存时长选择，默认 6 小时；也可明确选择只登记主机、稍后配置凭据。平台生成不可修改的主机 ID。主机公钥及指纹由首次 SSH 握手自动记录，无需填写或确认；后续连接自动比对，主机详情只读可查看公钥与指纹。指纹与主机 ID、用户名称作为资产元数据保存，不随登录凭据到期而删除。

| 登录凭据策略 | 有效期与清理 | Agent 激活后 |
| --- | --- | --- |
| 有限期保存（当前默认） | `retention=managed`，密码或私钥默认保存 6 小时，有限期最长 365 天；到期或撤销后清除秘密 | 保留至到期或撤销 |
| 永久保存（需明确选择并确认） | `retention=permanent`，`expires_at` 为空，无固定过期时间；主动撤销后清除秘密 | 继续保留，直到撤销 |
| 原有临时接入 | `retention=temporary`，最长 1 小时；到期、撤销或 Agent 激活后清除 | 清除，不是当前登记默认 |
| 原有一次性密码 | `retention=one_time`，一次检查或终端使用结束后清除；不能用于自动安装或卸载 | 不作为部署凭据 |

有限期保存和永久保存适用于终端、SSH 检查、单机/批量安装及卸载；保存成功后不会向网页回显秘密。永久保存不是延长到某个虚构远期时间，仍可随时撤销并立即断开使用该凭据的终端。建议优先短期保存，避免长期保留 SSH 秘密。登记或保存凭据本身不会执行 SSH，也不代表已经具备远程管理能力；若凭据保存失败，同一表单保留已登记主机 ID 供重试，不重复建档。切换登录方式、关闭并重新打开表单均不保留秘密输入。具体契约见 [SDD 039](../specs/039-host-registration-credential-retention/spec.md)。

点击“SSH 安装检查”会真实登录并执行固定只读检查：Linux、amd64/arm64、curl/tar/gzip/sha256sum、运行中的 systemd、root 或免交互 sudo、目标机器到平台 HTTPS 外部地址的连通性，以及已有 Agent 程序、服务、配置或身份。检查最长 60 秒，可以取消。平台尚为 HTTP 时仍能检查 SSH，但 HTTPS 条件不通过，不能生成自动安装计划。

也可以让 AI 助手“检查这台主机并准备安装 LightMoni Agent”。助手使用 `get_managed_machine`、`check_managed_machine_ssh` 和 `propose_agent_install`，通过后返回“审阅部署计划”入口。只有一个有效登录凭据时自动选择；多个凭据时需要明确指定凭据 ID。助手无法读取密码、私钥或原始 SSH 输出。

审核入口打开同一条已保存的部署计划。计划和检查有效期为 15 分钟；主机地址、端口、用户名、指纹、连接方式、平台外部地址或所选私钥改变后需要重新检查。生成计划、执行前及安装器生命周期锁内都会拒绝已有 Agent 安装，不能为测试或重试覆盖原节点身份。确认前不签发 enrollment token，也不安装。管理员明确确认后，中心内部创建绑定本主机 ID 的 enrollment 会话，再运行固定安装脚本。独立签发 token、用户复制命令手动安装和手工关联主机的入口均移除。脚本与发行包下载均需鉴权；一次性 token 由 SSH stdin 传入、写入远端 0600 临时 curl 配置，退出时清理，不进入 URL、命令参数、环境或回执。Agent 兑换、激活、注册和心跳均核验服务端主机预约及独立身份；注册早于安装完成回执时仍关联原主机，不会创建第二条资产。只有收到 Agent 激活回执才报告成功；若部署失败而本次 enrollment 已激活，平台只撤销该安装会话签发的新节点凭据，不影响已有节点，管理员需先核对远端残留再重新接入。检查通过仍不保证特定发行包存在、glibc 兼容或后续安装一定成功。

目前平台安装只支持直接 SSH，跳板机、SSM、离线手动接入和自动 sidecar 注入不在当前支持范围。管理员可使用有时限的网页 SSH 终端；终端输出不持久化，也不交给 AI。中心主机需有 `ssh` 和 `ssh-keyscan`（Docker 运行镜像包含 `openssh-client`）。Agent 激活后，日常采集和受限运维任务通过 Agent 通道执行。

`deploy/agent/install.sh` 是平台固定部署流程的内部执行器，不是面向用户的独立安装入口。平台为目标主机签发短期、一次性 enrollment，限定中心、版本/架构、初始任务标签及主机 ID； token 通过 SSH exec stdin 交给安装器，不能放入 URL、命令行、普通环境变量、日志或 AI 上下文。平台使用受保护下载鉴权获取固定发行包和 SHA256 清单；哈希只证明包与清单一致，签名发行仍待实现。维护发行物可使用 [构建器](../scripts/build-agent-release.mjs)，不通过生成独立 token 绕过主机管理。

没有主机预约的旧 token、独立 Agent 身份或共享 SDK Key 不再获准控制面接入，不自动补建或猜测主机，不自动删除数据库历史。重新接入应从登记主机的部署流程开始；已有程序、配置或身份存在时仍拒绝覆盖安装，必须先核对及卸载残留。

安装器暂存并校验配置和 bundled Node，再切换发行文件、启用并重启 systemd 服务；默认创建以下布局：

| 路径 | 用途 |
| --- | --- |
| `/usr/local/bin/lightmoni-agent` | launcher |
| `/opt/lightmoni-agent/releases/…`、`current` | root 管理的固定发行文件和当前版本链接；目录/可执行文件 0755，普通文件 0644，服务用户只读 |
| `/etc/lightmoni-agent/config.json` | 中心地址、独立 control/data credential、本地令牌；目录 0700、文件 0600 |
| `/var/lib/lightmoni-agent` | 持久身份、SQLite 队列、receipt、日志游标、缓存任务；目录 0700 |
| `/etc/systemd/system/lightmoni-agent.service` | 独立服务，用户 `lightmoni-agent` |

不要把运行过的身份和队列复制到其他独立主机。升级原机要保留整个状态目录；新主机使用空目录生成新身份。Agent 本地 `host_id` 是遥测资源标识，不是平台主机 ID，也不能作为重新关联资产的证明。主机 ID 由中心生成并通过安装预约绑定，不创建主机 ID/名称环境变量。

## 网络和任务权限

业务SDK仅直连中心，Agent不提供SDK接收和配置代理。本地监听只用于healthz/status诊断，local_token是本地诊断令牌，不是SDK密钥或Agent中心凭据。

Agent配置公网引导endpoint，自动查询管理员登记的中心内网IP和端口，每30秒同步；内网可达时全部中心请求使用内网，包括心跳、配置、任务通道、制品下载和遥测。旧内网失效时通过公网恢复最新清单。诊断/status的center_connection显示当前入口与修订。详见[中心地址同步](center-endpoints.md)。

中心建议使用受信 CA 的 HTTPS 443（本地开发常见 8080），不通过关闭证书验证解决 TLS 问题。Agent 默认每 30 秒主动取控制配置，单次请求超时 15 秒，无需开放中心→Agent 的控制端口。任务标签只决定任务分发，不授予 SSH、模型或任意命令执行权限。

每个 Agent 使用绑定 `agent_id` 与登记主机的独立 control/data credential：control 用于心跳和配置，data 用于遥测；中心保存摘要并按 audience、scope、有效期和撤销状态校验。SDK Key 不可替代控制凭据，注册/心跳不得创建或抢占主机资产。撤销不会在断网时即时停止缓存任务，配置租约仍待实现。

日志目录应明确授予服务用户文件读取及父目录遍历权限，可按业务组或 ACL 配置，不要为了读取日志默认改为 root。服务启用 `ProtectSystem=strict`、`ProtectHome=read-only`、`PrivateTmp=true`，只允许写状态目录。应用宿主 `/tmp` 日志不一定在该服务视图中可见，优先使用稳定日志目录；调整数据目录时也要同步审视 unit 的 `ReadWritePaths`。

## 检查与诊断

```sh
sudo systemctl status lightmoni-agent.service --no-pager
sudo journalctl -u lightmoni-agent.service -n 100 --no-pager
sudo -u lightmoni-agent /usr/local/bin/lightmoni-agent check --config /etc/lightmoni-agent/config.json
sudo -u lightmoni-agent /usr/local/bin/lightmoni-agent status --config /etc/lightmoni-agent/config.json
```

`check` 仅校验本地配置，不探测中心、网络或日志权限。`status` 使用本地令牌读取状态，关注 queue/隔离、配置 revision、collector 状态、最后错误与成功时间；最后成功时间在进程重启后重新开始记录。

安装时显示 `configuration valid` 只代表 root 对暂存配置的检查通过，随后仍可能在专用用户启动 systemd 服务时失败。安装器会在恢复旧文件之前显示失败阶段和固定 systemd 状态字段，再给出本机 `journalctl` 检查命令；不会自动打印可能包含敏感信息的原始日志。查看日志后请先移除凭据再分享。

旧安装器受 `umask 077` 影响可能把运行时复制为 root-only，造成配置检查通过但服务无法启动；修正版显式补足公开运行文件的读取和目录遍历权限，配置与状态目录继续保持 0700/0600。更新平台分发的 `install.sh` 后再安装；仅更新 Git 源码不会替换线上脚本。若本次 enrollment 已激活但启动失败，本地文件回滚本身不会撤销中心凭据：主机管理部署 worker 会按本次安装会话撤销新节点凭据。核对远端残留后从该主机重新检查并准备部署，不要复用已兑换的 token。

健康需要分别检查：

- 进程：systemd 是否运行；`/healthz` 是否能读队列统计。该接口不鉴权，只是有限存活检查。
- 控制：中心节点心跳是否新鲜、配置是否取得。当前网页在线阈值是 `max(90 秒, 3 × control_interval)`。
- 配置：期望与已应用 revision 是否相等；相等只表示任务配置装入，仍需看各任务状态。
- 数据：队列年龄/大小、隔离原因、上报错误及中心目标表实际数据。空闲节点没有业务数据不应直接判为故障。

首次没有有效缓存任务且中心离线时，主机/拨测/文件采集等待配置；本地 OTLP 和队列转发循环独立。已有有效缓存可继续离线任务，但当前无任务租约/到期撤销，中心撤回不会在断网时立即生效。运行事件在 Agent 内存中有界保存，未收到中心确认前崩溃可能丢失，不应作为完整持久审计。

## 离线容量和隔离恢复

Agent 在持久 SQLite 中事务保存 receipt、冻结 OTLP 内容和文件游标，成功提交后才向本地客户端 ACK。默认限制：单批 4 MiB、队列 256 MiB、10,000 批、100,000 receipts、最低空闲磁盘 32 MiB、最大重放年龄 24 小时、receipt 保存 48 小时。容量和期限都有限，隔离数据也占空间。

按“平均入队字节/秒 × 期望断网秒数 × 余量系数”估算数据容量，另留 SQLite/WAL、receipt、隔离和操作系统空间。默认 256 MiB 不能保证在任意流量下保留 24 小时；超过重放年龄的数据会隔离。满队列或存储失败返回 503 背压，客户端需要保留和重试。业务 SDK 的有限内存/重试策略也决定端到端保留能力。

网络、鉴权和限流故障会保留重试，401/403 不会清空队列；先修复 endpoint、TLS 或对应 data 凭据。不可重试、过期和部分成功批次进入隔离，不静默删除。需要维护隔离区时先停服务，避免把 CLI 描述成已具备运行时并发维护锁：

```sh
sudo systemctl stop lightmoni-agent.service
sudo -u lightmoni-agent /usr/local/bin/lightmoni-agent quarantine --config /etc/lightmoni-agent/config.json --action list
```

查明原因后，按实际 ID 执行 `--action retry --id ID`。只有接受数据丢失后才使用 `--action discard --id ID --confirm-data-loss`。维护完成重启服务并复查队列和中心数据。不要通过删除 queue 文件解除容量压力。

## 升级、回退和卸载

“部署 Agent”仍只用于首装；已有受管 Agent 从主机管理的“升级 Agent”准备独立维护计划。平台镜像升级不会自动升级用户主机。发行目录缺失、目标包不可用或 SSH 凭据失效时，先发布完整发行物或添加有效主机凭据。目录显示 version、source revision、build ID 和 SHA256，同为 `0.1.0` 也可能是不同程序。

1. 选择目标发行和有效的 SSH 密码/私钥，平台只读核对远端 Agent ID、架构、当前程序指纹、受管 unit 和任务锁。
2. 审阅固定目标 SHA、主机、影响与 15 分钟期限，明确确认执行。计划过期、主机变化或当前程序变化时重新生成计划。
3. 平台通过受限下载票据向目标暂存已审批包和维护器。root 独立 systemd 维护单元完成验证和切换，普通 Agent 仍以专用非 root 用户运行；SSH 断开不会直接终止该维护单元。
4. 平台观察同一 Agent 的新 boot、精确目标发行、心跳及配置应用，符合条件才确认成功。仅服务 active 或显示“已提交”不代表升级成功。
5. 启动失败或 180 秒内未获中心确认时，维护器自动尝试恢复之前程序。平台健康观察先结束时可能暂为“结果未知”，待远端完成后使用“核对结果”。核对只读，不重新执行或偷偷提交等待中的更新。

主机 ID、Agent 身份、control/data 凭据、配置、实时 SQLite 队列、游标和回执保持不变。程序回退不恢复旧队列快照；跨 state_schema 不支持自动操作。本轮只接受 schema 1，未知程序及任意手改 unit/路径不能直接升级。已识别的旧受管 0.1.0 Node 包可作为升级来源和失败自动恢复目标；主动回退目标需要支持新 boot/发行证明的完整 metadata，缺失时拒绝。

升级历史独立记录“待审阅、更新中、健康核验、成功、已自动回退、失败、结果未知、取消”。“已自动回退”表示目标程序未成功，但旧程序已恢复；回退失败仍为未知，先人工核查。平台重启会把未确认操作标为未知，不能根据时间推断成功或自动重试。掉电可能中断维护器，主机恢复后需要核对持久事务与真实服务状态。

可选择多台主机创建升级批次，最多 20 台，服务端串行执行。每台计划和结果分别保存；失败、回退或未知自动暂停，明确继续只处理未启动项。取消批次不会声称已恢复正在运行的机器；已开始操作仍由其自身确认/回退流程结束。计划期限或凭据已失效的剩余主机需要重新准备。

AI 工具 `list_agent_releases`、`propose_agent_update`、`get_agent_update` 可查询和准备升级/回退审阅链接，无直接执行或 commit 工具。任务中心将逐步统一外部 API、界面与 AI 的提交和记录，Agent 生命周期保持独立审批与恢复协议。规格、接口和实际验收边界见 [SDD 045](../specs/045-agent-lifecycle-updates/spec.md) 与 [系统设计第 28 节](system-design.md#28-agent-版本升级与回退sdd-045)。

### 通过主机管理安全卸载

删除主机记录与卸载远端 Agent 是不同操作。关联有效 Agent 的主机须先移除该身份后才允许删除；移除只撤销中心身份，不停止远端程序。卸载应从主机管理独立发起，自动比对已记录的主机身份，并使用仍有效的密码或私钥。默认 6 小时的有限期凭据、明确确认的永久凭据在 Agent 激活后继续保留，可在有效期间用于卸载；已到期、已撤销或原临时凭据被清除时，需要重新添加登录凭据。原一次性密码不适用于固定卸载。

1. 运行新的 SSH 检查，再生成卸载计划。平台以固定只读探测核对远端身份属于本平台独立凭据节点、与已有主机关联一致且未绑定其他主机，拒绝身份不一致、无法确认节点以及运行中、已派发或结果未知的节点任务。主机关联本身不能单独代替远端身份核验。
2. 审阅目标、影响与保留内容，明确确认后执行。计划绑定当前主机地址、端口、用户名、指纹、私钥和节点身份，沿用 SSH 检查的 15 分钟有效期，有效期内也不能在连接参数改变后继续使用；未执行计划可以取消。
3. 平台仅执行内置固定脚本：核对标准路径的受管 `lightmoni-agent.service`，拒绝其他来源的同名 unit，停止并禁用服务，确认停止后移除该服务文件、`/usr/local/bin/lightmoni-agent` 和 `/opt/lightmoni-agent`。停止失败不会继续删除程序。
4. 保留 `/etc/lightmoni-agent`、`/var/lib/lightmoni-agent` 和服务用户，保留业务服务、部署目录、制品、容器和卷。网页不开放 purge；保留配置、身份、缓存和队列用于核查与恢复，不保证未送达数据自动补传。
5. 程序路径移除、服务 not-found 且未运行、身份匹配、数据目录保留及无未完成任务标记全部核验通过后，中心在同一事务中撤销对应节点的全部 control/data 凭据并完成记录，保存主机、节点和卸载历史。配置文件里的旧凭据此后无效，已登记节点也不能降级到 legacy Key；重新接入需要新 enrollment，不能将保留配置直接当作有效安装继续启动。

SSH 断开或结果不确定时状态为“结果未知”，平台不会报告成功或自动重跑卸载。管理员可用“核对卸载结果”执行固定只读探测：完全移除且全部核验条件满足后才补做凭据撤销并成功；完整程序仍在、服务状态明确且无生命周期锁或任务标记时记为失败，保留节点凭据，可重新审阅新计划；只移除了一部分或状态不确定时保持未知。原临时私钥已到期时，可添加新的有效私钥用于只读核对。节点任务结果不明时先核对任务。同一节点的卸载与任务按节点身份跨主机互斥，主机检查、网页终端、安装和卸载执行互斥；待审核/结果未知时允许管理员用终端人工核查，但禁止改主机、删除或新部署，实际卸载或核对时不能同时打开终端。

内部脚本 `uninstall.sh` 默认保留配置和状态；单独运行本机脚本不能证明中心已撤销身份。网页只提供受审阅、可核对的固定卸载流程，不开放 purge；维护工具的 purge 会删除已 ACK 未转发的数据，不能当作常规卸载。恢复或重新接入前先核查保留数据和身份，平台首装不会自动覆盖它们。实现规格、契约和验收证据见 [SDD 032](../specs/032-agent-install-uninstall/spec.md)。

## 容器业务如何接入

| 场景 | 建议与限制 |
| --- | --- |
| 容器应用，需要主机指标 | 保留宿主 systemd Agent；为容器选择可达宿主地址与 token，不把应用自身 loopback 当宿主 |
| 多容器只需 OTLP 转发 | 后续独立 Agent 容器方案，共享网络用 Agent DNS:4318，非 loopback 监听、local_token、独立持久卷 |
| 文件日志 | 显式只读挂载或宿主目录 ACL；没有自动 Docker 日志发现能力，不默认挂 Docker socket |
| 容器采完整宿主指标 | 当前未验收；需采集器路径/namespace 适配与数据对照，不能仅挂 `/host/proc` 宣称完成 |

Agent 容器的 `127.0.0.1`、应用容器的 `127.0.0.1` 和宿主各不相同。Linux host 网络或 host gateway 需要显式选择并检查暴露范围；`host.docker.internal` 不保证普遍可用。后续容器默认非 root、只读根目录、固定 digest、受限日志挂载、持久状态和秘密配置，不要求 privileged 或全宿主读写。

仓库根 Compose、with-clickhouse Compose 和 [server Dockerfile](../deploy/server/Dockerfile) 均启动中心服务，不是 Agent 镜像。当前没有可直接引用的 Agent 镜像发布地址；不要用中心镜像的默认入口替代 Agent 部署，也不要把 Agent 生命周期默认绑定业务 sidecar。

## 后续设计

待实现项包括凭据自动/管理员轮换与重新 enrollment、签名发行元数据、配置租约、业务健康观察门槛、跨 state_schema 的状态迁移与回退设计、amd64 真实升级/回退与双架构全场景验收，以及独立 Agent 转发容器。统一任务 API 仍为后续设计，不能将当前升级接口视为已完成的外部通用执行入口；采集 Key 和标签不授予命令执行或提权。

完整规格与未完成清单：[规格](../specs/010-agent-deployment/spec.md) · [设计](../specs/010-agent-deployment/plan.md) · [当前/未来契约](../specs/010-agent-deployment/contracts.md) · [任务](../specs/010-agent-deployment/tasks.md)。

## 安装器内部身份流程

enrollment 是平台部署流程的短期内部凭据，不是独立用户接入产品。中心签发时保存主机预约，安装器生成 `install_nonce` 和本机身份材料并兑换 pending bootstrap；同 nonce 重试可恢复会话，不创建第二个 Agent。配置检查后调用 activate，中心核验主机预约并签发独立 control/data 凭据，安装器原子保存 0600 配置后启动 systemd 服务。激活只是安装器完成配置预检，不能代替进程、控制面和遥测分别验收。

`agent_public_key` 当前是预留元数据，尚未实现签名持有证明，实际认证边界是 bootstrap、control 和 data bearer credential。节点 ID 或 `host_id` 不能单独授权。凭据自动轮换和完整重新 enrollment 流程仍待实现，管理员撤销后不能恢复旧秘密；重新接入经该主机的新部署计划进行，不生成独立接入 token。

## 用户部署顺序

业务服务与中心可以在不同机器。先在平台登记业务所在主机并配置可达的 SSH 连接，再按需部署 Agent；业务已运行时无需停机。平台在首次安装、Agent 自身升级/回退、卸载或恢复时使用 SSH，Agent 日常主动通过 HTTPS 访问中心，中心不需要入站访问 Agent 的控制端口。多台主机使用列表复选框逐台预检并统一审阅部署计划；每台主机有自己的预约和身份，不复制 token 或身份目录。

SDK 直接使用中心地址和 SDK Key，业务可以先启动或完全不装 Agent，不因 Agent 缺失而阻塞打点。容器业务优先由宿主机独立 systemd Agent 采集宿主指标；当前没有独立 Agent 容器发布或自动 sidecar/DaemonSet 注入能力，不将容器身份当作宿主机证明。

## 平台主机标识

平台在登记时自动生成不可变主机 ID，由用户设置主机名称。名称可修改，同名资产以 ID 区分；详情展示 ID 供核对。主机资产 ID 与 Agent 安装身份分开，关系只由中心主机预约与认证接入建立，不支持用户手工配对。

当前不为业务或 Agent 创建主机 ID/名称环境变量，也不新增 SDK 读取能力。SDK 保持独立直报；登记主机不修改已有业务启动环境。


## Docker 清单与即时操作（SDD 057）

主机的“应用与 Docker”显示平台部署及本机全部容器，包含停止的和非平台创建的容器。定期采集之外，“立即采集”通过已认证 Agent 的持久任务查询 Docker，不等待下次指标采集。管理员可确认后启动、停止、重启已有容器；任务完成后验证状态并更新清单。操作外部容器不会创建平台应用；平台应用容器可能被调度器恢复到期望状态。

需要同时升级中心与 Agent。旧 Agent 未声明 `docker.inventory` / `docker.control` 时只显示已有快照并提示升级。中心不连接 Docker socket；Agent 使用本机固定 `default` context，不继承交互终端的 `DOCKER_HOST` 或其他 context。

标准安装以 `lightmoni-agent` 用户运行，安装器不会自动授予 Docker 管理权限。主机必须有 Docker CLI、运行中的 daemon，并显式允许该服务用户访问目标 socket。在主机管理员核对授权后，按该主机的 Docker 安全策略配置组或 ACL，并重启 Agent 服务使新权限生效；Docker 管理权限可控制宿主机，不能通过将 socket 设为全员可写来解决。

只读排查可在主机执行：

```sh
id lightmoni-agent
ls -l /var/run/docker.sock
sudo -u lightmoni-agent docker --context default ps --all --no-trunc
```

页面区分 CLI 缺失、socket 权限不足、daemon 不可达和命令超时，显示最近尝试并保留旧清单。排队超时说明 Agent 未领取任务；`unknown` 说明可能已产生效果，先立即采集并检查容器，不直接重复操作。节点写锁在未知结果时保留，管理员需核对原执行已终止及现场状态后处理恢复。
