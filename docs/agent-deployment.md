# LightMoni Agent 部署与恢复

本文说明当前可用部署方式及后续设计。推荐每台 Linux 主机一个独立 systemd Agent，使用专用非 root 用户运行，身份与离线数据放在固定持久目录。Agent 不随业务应用重启、发布或删除；业务通过 SDK 上报或授权日志目录接入。节点助手现在支持一次性 enrollment、pending 激活和独立的 control/data credential；旧节点仍可通过 legacy Key 运行。

本次基线已在中心、安装脚本和运行时测试中实现，但没有执行真实主机安装、升级或发布容器。现有 Node 迁移的 Linux 双架构 systemd 实机验收仍待完成，当前 shell 安装测试使用命令 shim。参见 [验收边界](../specs/007-node-runtime-migration/agent-validation.md)。

## 当前支持范围

| 项目 | 当前能力 |
| --- | --- |
| 主机 | Linux amd64/arm64、systemd、glibc ≥ 2.28；安装需要 root，常态运行专用用户 |
| 运行时 | 发行包自带 Node 24.15.0、应用及生产依赖，目标机器不用另装 Node/npm |
| 数据 | 主机/进程指标、HTTP/TCP 拨测、授权目录日志、本地 OTLP HTTP 接收转发 |
| 中心连接 | Agent 主动注册/心跳/拉取配置与上报；不需要中心入站连接 Agent |
| 本地 SDK | 默认 `127.0.0.1:4318`，OTLP HTTP `/v1/logs`、`/v1/metrics`、`/v1/traces`；无 gRPC 4317 |
| 容器 | 现有 Compose 和 server Dockerfile 部署中心；尚无独立 Agent 发布镜像或已验收宿主采集容器 |

不支持把 Linux glibc 发行包直接用于 Alpine/musl。采集任务是结构化主机/拨测/日志配置，没有 Agent 远程任意 shell 或 AI 指令执行能力。

## 准备与安装

### 通过主机管理和 AI 助手首次安装

管理员在“主机管理”登记目标主机的地址、SSH 端口、用户名，以及通过可信渠道核对的 `SHA256:...` 主机公钥指纹，再保存该主机专用、无需口令的 SSH 私钥。密码仅供短期登记，不用于自动 SSH；建议不要长期保存密码，安装完成后也可以撤销首次接入私钥。

点击“SSH 安装检查”会真实登录并执行固定只读检查：Linux、amd64/arm64、curl/tar/gzip/sha256sum、运行中的 systemd、root 或免交互 sudo，以及目标机器到平台 HTTPS 外部地址的连通性。检查最长 60 秒，可以取消。平台尚为 HTTP 时仍能检查 SSH，但 HTTPS 条件不通过，不能生成自动安装计划。

也可以让 AI 助手“检查这台主机并准备安装 LightMoni Agent”。助手使用 `get_managed_machine`、`check_managed_machine_ssh` 和 `propose_agent_install`，通过后返回“审阅部署计划”入口。只有一个有效私钥时自动选择；多个私钥时需要明确指定凭据 ID。助手无法读取密钥或原始 SSH 输出。

审核入口打开同一条已保存的部署计划。计划和检查有效期为 15 分钟；主机地址、端口、用户名、指纹、连接方式、平台外部地址或所选私钥改变后需要重新检查。确认前不签发 enrollment token，也不安装。管理员明确确认后运行固定安装脚本，只有收到 Agent 激活回执才报告成功。检查通过仍不保证特定发行包存在、glibc 兼容或后续安装一定成功。

目前自动 SSH 仅支持直接连接。跳板机和 SSM 使用手动安装脚本；不提供通用远程 shell 或网页终端。中心主机需有 `ssh` 和 `ssh-keyscan`（Docker 运行镜像包含 `openssh-client`）。Agent 激活后，日常采集和任务仍通过 Agent 通道执行。

升级前生成的旧待审核计划不含 SSH 检查绑定，需要重新检查并生成计划；已完成的部署历史保留。

1. 管理员在“节点助手”确定可信 HTTPS 中心地址、版本/架构、初始任务标签和凭据作用域，生成一次性 enrollment 会话。不要使用管理员登录会话凭据。
2. 从受信发行渠道取得固定版本 `install.sh`、对应架构 tar 包及 `SHA256SUMS`，预置到目标主机的受限目录。源码构建使用 `npm run release:agent`，产物默认位于 `runtime/downloads`，入口为 [构建器](../scripts/build-agent-release.mjs)。
3. 验证发行来源和包哈希。SHA256 只校验包与清单一致；同源包和清单不提供签名认证。当前没有签名更新机制，不能把校验成功解释成完整供应链认证。
4. 将页面只显示一次的 enrollment token 交给目标主机的秘密管理或运维流程，以 root 可读、权限 0600 的文件或受限 FD 传给安装器；不要把 token 写进命令历史。

以下假设可信产物在 `/srv/lightmoni-agent/releases/0.1.0`，enrollment token 已安全放在 `/run/secrets/lightmoni-agent-enrollment-token`；域名需换成实际中心。使用 root shell 读取秘密文件，token 内容不会成为下面命令的参数：

```sh
sudo sh -c 'exec sh /srv/lightmoni-agent/releases/0.1.0/install.sh \
  --release-dir /srv/lightmoni-agent/releases/0.1.0 \
  --version 0.1.0 \
  --endpoint https://monitor.example.com \
  --enrollment-token-stdin < /run/secrets/lightmoni-agent-enrollment-token'
```

可选 `--group-id <initial-task-label-id>` 仅用于初次任务标签；后续标签与任务在中心管理。`--config FILE` 可为首装提供完整配置；已有安装优先保留原配置，不通过此参数替换。enrollment token 只通过 stdin/受限文件传入，不会写入安装命令；脚本兑换后把 bootstrap、control/data credential 写入权限为 0600 的配置并清理临时文件。不要启用 shell tracing，也不要把配置和秘密加入诊断附件。用完临时秘密后按所在秘密系统的生命周期回收。

当前在线模式支持 `--release-url URL --enrollment-token-stdin`；安装器使用临时 curl 配置文件下载发行物，网页命令不包含 token。`--key-stdin` 仍保留给未重新 enrollment 的旧节点，迁移完成前需按 legacy 路径管理其权限。签名发行、sudo/审计链路和断电恢复仍需单独验收。

安装器暂存并校验配置和 bundled Node，再切换发行文件、启用并重启 systemd 服务；默认创建以下布局：

| 路径 | 用途 |
| --- | --- |
| `/usr/local/bin/lightmoni-agent` | launcher |
| `/opt/lightmoni-agent/releases/…`、`current` | root 管理的固定发行文件和当前版本链接；目录/可执行文件 0755，普通文件 0644，服务用户只读 |
| `/etc/lightmoni-agent/config.json` | 中心地址、control/data credential（旧节点为 legacy Key）、本地令牌；目录 0700、文件 0600 |
| `/var/lib/lightmoni-agent` | 持久身份、SQLite 队列、receipt、日志游标、缓存任务；目录 0700 |
| `/etc/systemd/system/lightmoni-agent.service` | 独立服务，用户 `lightmoni-agent` |

不要把运行过的身份和队列复制到其他独立主机。升级原机要保留整个状态目录；新主机使用空目录生成新身份。当前身份为本地 UUID，不是中心签发的节点证明。

## 网络和任务权限

默认同宿主应用向 `http://127.0.0.1:4318` 上报。`local_token` 用于 SDK→Agent OTLP、状态和配置代理；它与 Agent→中心的 `key` 不同。非 loopback 监听强制需要 `local_token`；共享主机即使只用 loopback 也建议设置，本机其他用户同样能连接 loopback。

中心建议使用受信 CA 的 HTTPS 443（本地开发常见 8080），不通过关闭证书验证解决 TLS 问题。Agent 默认每 30 秒主动取控制配置，单次请求超时 15 秒，无需开放中心→Agent 的控制端口。上报 Key 的表范围必须覆盖任务目标表；任务标签分配成功不意味着写入授权一定匹配，403 应检查 Key 范围。

新 enrollment 节点使用绑定 `agent_id` 的独立 control/data credential：控制凭据用于心跳和配置，数据凭据用于遥测；中心只保存摘要并按 audience 校验。旧节点仍可能使用同一长期 `config.key` 兼容下载、控制和数据上报，直到完成迁移。撤销不会在断网时即时停止缓存任务，配置租约仍待实现。

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

旧安装器受 `umask 077` 影响可能把运行时复制为 root-only，造成配置检查通过但服务无法启动；修正版显式补足公开运行文件的读取和目录遍历权限，配置与状态目录继续保持 0700/0600。更新平台分发的 `install.sh` 后再安装；仅更新 Git 源码不会替换线上脚本。若本次 enrollment 已激活但启动失败，本地文件回滚不会撤销中心凭据：请先在平台撤销该失败节点的凭据，再新建一次性 token 重装，不要复用已兑换的 token。

健康需要分别检查：

- 进程：systemd 是否运行；`/healthz` 是否能读队列统计。该接口不鉴权，只是有限存活检查。
- 控制：中心节点心跳是否新鲜、配置是否取得。当前网页在线阈值是 `max(90 秒, 3 × control_interval)`。
- 配置：期望与已应用 revision 是否相等；相等只表示任务配置装入，仍需看各任务状态。
- 数据：队列年龄/大小、隔离原因、上报错误及中心目标表实际数据。空闲节点没有业务数据不应直接判为故障。

首次没有有效缓存任务且中心离线时，主机/拨测/文件采集等待配置；本地 OTLP 和队列转发循环独立。已有有效缓存可继续离线任务，但当前无任务租约/到期撤销，中心撤回不会在断网时立即生效。运行事件在 Agent 内存中有界保存，未收到中心确认前崩溃可能丢失，不应作为完整持久审计。

## 离线容量和隔离恢复

Agent 在持久 SQLite 中事务保存 receipt、冻结 OTLP 内容和文件游标，成功提交后才向本地客户端 ACK。默认限制：单批 4 MiB、队列 256 MiB、10,000 批、100,000 receipts、最低空闲磁盘 32 MiB、最大重放年龄 24 小时、receipt 保存 48 小时。容量和期限都有限，隔离数据也占空间。

按“平均入队字节/秒 × 期望断网秒数 × 余量系数”估算数据容量，另留 SQLite/WAL、receipt、隔离和操作系统空间。默认 256 MiB 不能保证在任意流量下保留 24 小时；超过重放年龄的数据会隔离。满队列或存储失败返回 503 背压，客户端需要保留和重试。业务 SDK 的有限内存/重试策略也决定端到端保留能力。

网络、鉴权和限流故障会保留重试，401/403 不会清空队列；先修复 endpoint、TLS、Key 或表权限。不可重试、过期和部分成功批次进入隔离，不静默删除。需要维护隔离区时先停服务，避免把 CLI 描述成已具备运行时并发维护锁：

```sh
sudo systemctl stop lightmoni-agent.service
sudo -u lightmoni-agent /usr/local/bin/lightmoni-agent quarantine --config /etc/lightmoni-agent/config.json --action list
```

查明原因后，按实际 ID 执行 `--action retry --id ID`。只有接受数据丢失后才使用 `--action discard --id ID --confirm-data-loss`。维护完成重启服务并复查队列和中心数据。不要通过删除 queue 文件解除容量压力。

## 升级、回退和卸载

升级继续使用同一安装器和明确的固定版本 `--release-dir`/`--version`；保留身份与数据目录，不要为重装生成新身份。先保留已知可用包，记录当前版本、配置 revision 和队列状态，确认待升级版本的状态兼容说明。

当前安装器在普通错误及 HUP/INT/TERM 时恢复旧配置、launcher、unit、current 和服务原启用/运行状态；恢复失败会保留备份路径供人工处理。它不打开或重格式化 live spool，但新版服务在失败前可能已写入状态。以下边界需要在升级前理解：

- 掉电、SIGKILL、系统崩溃可能跳过 shell trap，不能保证自动恢复。
- 安装文件恢复不还原数据目录/schema；不能直接假定任意旧版可以读取新版状态。
- 安装器在 restart 成功后最多观察 10 次 `systemctl is-active`，间隔 1 秒，连续两次 active 才报告成功。该观察只验证短期本机进程状态，不验证中心登记、任务或数据送达，成功后没有自动健康回滚和批量 rollout。

升级后使用上述诊断并检查中心数据。需要回退时，先确认旧版可读当前 schema；不可逆变更需采用升级前一致快照恢复。制作快照应先停服务，再按 SQLite 一致备份方法保存整个必要状态及配置；运行中只复制 `queue.sqlite` 可能遗漏 WAL。不要用未验证的旧包直接覆盖活跃状态。

默认卸载保留 `/etc/lightmoni-agent` 和 `/var/lib/lightmoni-agent`，以后可恢复身份和补传。`uninstall.sh --purge` 会删除配置和状态，包括已 ACK 但未转发的数据，必须明确接受数据丢失后使用。

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

待实现项包括凭据自动/管理员轮换与重新 enrollment、签名发行元数据、配置租约、分层健康和升级观察门槛、兼容快照/回退、真实 Linux 双架构验收，以及独立 Agent 转发容器。未来智能执行需另设默认关闭的执行器与权限、审批、隔离、取消和审计，采集 Key 和标签不授予命令执行或提权。

完整规格与未完成清单：[规格](../specs/010-agent-deployment/spec.md) · [设计](../specs/010-agent-deployment/plan.md) · [当前/未来契约](../specs/010-agent-deployment/contracts.md) · [任务](../specs/010-agent-deployment/tasks.md)。

## 面向用户的脚本安装与每节点身份（已实现基线）

“节点助手”安装页现在由管理员创建 enrollment 会话，生成一次性 token；安装器使用 token 下载/兑换 pending 节点，健康检查通过后激活并取得独立 control/data credential。本机 `identity.json` 仍保存随机 `agent_id/host_id` 等本地身份材料，但不单独构成中心认证凭据。`config.key` 只作为未重新 enrollment 节点的兼容路径。

生产接入应由管理员在“节点助手”生成一次性安装会话，再让用户在目标主机运行固定版本脚本。会话限定中心、版本/架构、初始任务标签和凭据作用域，默认 15 分钟过期且只能兑换一次。网页只在生成时显示 enrollment token；刷新页面只显示会话 ID 和状态，不再显示秘密。

脚本不把 token 放进 URL、argv 或普通环境变量。交互式模式隐藏输入，自动化模式从权限为 0600 的秘密文件或受限 FD 通过 `--enrollment-token-stdin` 传入。生产建议先下载脚本、验证签名/哈希和 HTTPS，再执行固定文件；不把 `curl | sh` 作为默认安装方法。示例：

```sh
curl --fail --proto '=https' --tlsv1.2 -o /tmp/lightmoni-agent-install.sh \
  https://monitor.example.com/downloads/agent/install.sh
chmod 700 /tmp/lightmoni-agent-install.sh
sudo sh -c 'exec /tmp/lightmoni-agent-install.sh \
  --endpoint https://monitor.example.com --version 0.1.0 \
  --enrollment-token-stdin < /run/secrets/lightmoni-agent-enrollment-token'
rm -f /tmp/lightmoni-agent-install.sh
```

安装器生成 `install_nonce` 和本机身份元数据，先兑换为短期 pending bootstrap，校验暂存配置后以 `service=ready`、`config_checked=true` 调用 activate。这里是安装器的配置预检，不是中心独立验证 Agent 进程已经运行。中心随后把节点置为 active 并签发每节点独立的 control credential 与 data credential，安装器才原子写入配置、身份并启动 systemd 服务；如果后续启动失败，需要管理员撤销该节点凭据后重试。中心端重试必须复用同一 nonce，不会创建第二个节点；若首次兑换响应丢失，同 nonce 恢复会轮换并重新返回 bootstrap secret。激活前失败的 pending 会等待过期。已有节点升级不会重新注册或删除身份、队列和缓存配置；自动撤销、轮换和重新 enrollment 尚待补齐。

每个节点的 `agent_id` 由中心绑定到 enrollment 时提交的身份材料和凭据摘要。当前提交的 `agent_public_key` 只是预留的节点元数据，尚未实现签名持有证明；实际认证边界是 bootstrap、control 和 data bearer credential。控制凭据仅用于心跳、配置拉取和状态证明；数据凭据仅用于允许的遥测上报；本地 SDK 使用的 `local_token` 不发送到中心。中心只保存摘要，UI、审计、journal、诊断和错误输出只显示 credential ID、状态和时间，不显示完整 token。请求同时验证 token 的 audience、scope、有效期、撤销状态和 `agent_id`，不能靠请求体中的节点 ID 授权。签名身份绑定属于后续发行与凭据强化工作。

未来轮换设计是 Agent 在凭据接近过期时通过旧控制凭据和幂等 nonce 申请轮换，把新凭据写入 0600 临时文件并原子替换，确认后旧凭据只在短 grace 窗口内有效。当前仅支持管理员按节点或 audience revoke；撤销保留身份、队列和审计，但旧 token 不可恢复，重新接入必须生成新的 enrollment。断网时撤销无法即时停止已缓存任务，界面应显示待重连状态；配置租约实现后再以租约期限限制离线执行。

完整的 endpoint、状态和验收项见 [部署规格](../specs/010-agent-deployment/spec.md)、[契约](../specs/010-agent-deployment/contracts.md) 和 [任务](../specs/010-agent-deployment/tasks.md)。当前新 enrollment 节点已使用每节点绑定凭据；旧 `config.key` 兼容路径仍未完成收敛。

### 用户应该怎样部署

用户不需要把业务服务迁移到 LightMoni 所在机器，也不需要先停掉业务。推荐在“节点助手”中为每台目标主机生成独立 enrollment 会话，然后在该主机运行安装脚本。Agent 作为独立 systemd 服务启动，主动通过 HTTPS 访问中心；中心不连接目标主机。业务服务可以先启动，Agent 后装仍能开始采集；为了减少 SDK 初始重试，生产发布通常先装 Agent，再启动或重启业务服务。

如果有很多主机，用户可以用 Ansible、SSH、云厂商 SSM、cloud-init 或内部软件仓库批量调用同一个脚本。每台主机仍生成自己的 `install_nonce` 和节点凭据，不能把一个 token 或 `identity.json` 复制到多台机器。没有公网的环境可以把已校验的固定发行包和一次性 enrollment 文件通过可信介质带入，再按受限网络流程激活。

容器场景有两种边界：只做 OTLP 转发时可以用独立 sidecar/DaemonSet；要采集宿主指标、进程或目录日志，优先把 Agent 安装在宿主机，或明确挂载目录、网络和 namespace。Agent 不应作为业务容器的默认生命周期依赖，也不应默认要求 privileged 或 Docker socket。
