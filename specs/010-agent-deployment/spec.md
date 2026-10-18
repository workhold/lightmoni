# Feature Specification: LightMoni Agent 独立部署

Created: 2026-10-18 · Branch: feat/assistant-alert-controls · Status: Baseline implementation delivered; hardening and Linux acceptance remain

## User intent and scope

为 LightMoni Agent 提供可维护的安装、运行、升级、恢复和诊断方式。Agent 的生命周期独立于业务应用，默认每台主机一个实例，由 Linux systemd 管理；应用重启、发布或删除不应删除节点身份和已接收的监控数据。本轮已实现 enrollment/activate 基线、脚本接入和节点 control/data 凭据；不执行真实主机安装、升级、容器发布或远程操作。

Agent 当前执行中心配置的主机采集、HTTP/TCP 拨测、文件日志采集及本地 OTLP 接收转发。这里的“任务”是有结构、经校验的采集配置，不包含任意 shell、脚本或 AI 指令执行。将来如需智能执行，必须另设执行器、授权和审计边界，不能让采集 Key、节点标签或安装权限自动成为执行权限。

## Current capability baseline

| 方面 | 已有实现 | 本设计中的后续能力 |
| --- | --- | --- |
| 发行包 | Linux amd64/arm64，自带 Node 24.15.0，要求 glibc ≥ 2.28，包 SHA256 校验 | 可信发行元数据、签名验证及过期/降级保护 |
| 主机服务 | 非 root systemd 服务，独立配置与数据目录，开机启动和失败重启 | Linux 双架构实机验收与更完整诊断 |
| 安装升级 | 暂存校验、原子版本链接切换、普通安装失败时恢复先前文件与服务状态 | 登记/配置/数据健康门槛、版本兼容策略与分阶段发布 |
| 注册授权 | 新节点可用短期一次性 enrollment token 兑换 pending bootstrap，再激活为绑定节点的 control/data credential；旧节点仍兼容长期上报 Key | 凭据轮换/重新 enrollment、legacy Key 收敛及离线租约 |
| 离线运行 | SQLite 队列、receipt、日志游标；缓存有效采集配置；有限容量背压与隔离 | 配置租约策略、容量诊断及持续断网验收 |
| 容器 | 现有 Compose/Dockerfile 部署中心服务并提供 Agent 下载包 | 独立 Agent 镜像与受限转发/日志部署；主机采集另行适配验收 |
| 智能执行 | 当前无 Agent 远程任意命令协议 | 可选独立执行器；不属于本次部署实现 |

SHA256 校验只能验证取得的包是否与校验清单一致。同一来源同时提供包和清单，不等于签名或可信发行方认证。现有包和 systemd 安装已做构建/脚本测试，但 [迁移验收记录](../007-node-runtime-migration/agent-validation.md) 明确保留 Linux 二进制和 systemd 实机验收缺口。

## User scenarios and acceptance

### US1 独立于业务应用运行（P1）

运维在主机上安装 Agent，业务应用分别通过 SDK 或日志文件接入。业务更新和重启期间 Agent 继续采集和缓冲；业务删除不移除 Agent 服务和数据目录。

Acceptance: Agent 作为独立 systemd unit 运行，进程为专用服务用户；应用重启不改变 `agent_id`、`host_id`、队列及配置。目标主机不依赖全局 Node/npm，不将 Agent 放入应用镜像作为默认部署方式。

### US2 可识别且受控地接入中心（P1）

管理员选择明确的中心地址、最小表范围 Key 和初始任务标签，安装后能区分进程启动、中心可达、配置应用和实际数据送达状态。

Acceptance: 配置和秘密权限受限，默认仅监听 loopback；跨容器或主机暴露 OTLP 时使用本地令牌和网络限制。节点助手生成的 enrollment token 只显示一次，脚本通过 stdin/受限文件兑换；本地 UUID 不作为中心认证身份，节点 control/data credential 由中心绑定签发。旧长期上报 Key 仅作为明确的兼容路径。

### US3 断网、限额和恢复可解释（P1）

Agent 与中心断联后继续执行已有有效缓存任务，接受容量范围内的本地遥测，重连后补传。首次安装无有效任务缓存时明确等待中心配置。

Acceptance: 已持久接收的数据、receipt、日志游标及身份跨重启保留；满队列/存储失败返回背压，不伪造成功 ACK；过期、拒绝及部分成功批次进入隔离区。文档说明容量、保留期、隔离占用及 SDK 重试边界，不承诺无限离线或分布式 exactly-once。

### US4 升级失败可恢复（P1）

运维以固定版本升级 Agent，安装过程不清空身份、队列、游标和缓存配置。新服务启动失败时恢复先前安装；启动后数据异常时有人工诊断和恢复路径。

Acceptance: 当前安装事务边界和失败恢复步骤有文档；SIGKILL/断电、已运行新版对数据目录的写入和跨 schema 降级不被称为自动回滚保证。后续健康门槛至少覆盖进程、控制配置、队列及上报，并在实现前确定数据 schema 兼容或快照恢复策略。

### US5 容器接入选择准确（P2）

业务使用容器时，管理员能选择主机 Agent 或未来的独立转发容器，并了解网络命名空间、日志访问和主机采集的限制。

Acceptance: 文档说明 loopback、共享网络名称、host gateway/host 网络选择及本地令牌要求。不得把中心镜像当作 Agent 镜像，不得宣称任意挂载 `/host/proc` 即可获得完整主机指标；不默认要求 privileged、Docker socket 或全盘读写挂载。

## Requirements

- FR-001 默认部署为每主机一个独立 systemd 服务，安装需要 root，运行使用 `lightmoni-agent` 专用无登录用户。
- FR-002 配置、持久状态和可替换发行文件分离；升级和默认卸载保留身份、队列、receipt、日志游标和任务缓存。克隆主机不得复用另一节点的身份与队列。
- FR-003 Linux amd64/arm64 发行包包含固定 Node 运行时、应用和生产依赖；目标机器不执行 npm 安装。glibc、架构和包校验要求可预检。
- FR-004 Agent 主动拉取中心控制配置并上报，无需中心主动连接 Agent；本地 OTLP HTTP 接口与中心地址、Key 作用域分别说明。
- FR-005 上报 Key、本地 `local_token`、管理员会话和未来引导/执行凭据明确区分；秘密不得出现在命令示例、诊断导出和运行事件中。
- FR-006 enrollment 安装路径不得把 token 放入 URL、argv、普通环境变量、shell history 或诊断；网页命令只包含 `--enrollment-token-stdin`，token 单独交给脚本。旧 `--key-stdin` 仅保留兼容迁移路径，待 T035 收敛。
- FR-007 日志采集仅授予所需文件和目录的读取/遍历权限；不得为了采集默认改为 root 或开放任意命令执行。
- FR-008 队列持久 ACK、容量背压、有限重放、隔离及恢复流程跨版本保持；缓存任务无租约的撤权延迟必须可见。
- FR-009 区分本地存活、控制可达、任务已应用及采集/数据交付健康；现有 `/healthz` 和 `systemctl is-active` 不充当完整 readiness 证据。
- FR-010 升级事务记录文件回退边界，未来健康失败回退必须先定义状态兼容性；保留已知可用发行物并为破坏性状态迁移提供一致快照方案。
- FR-011 容器转发和容器内主机采集分开验收。后者需要采集器显式支持宿主路径/命名空间，不能靠文档中的挂载推定已支持。
- FR-012 将来智能执行独立关闭、独立凭据与能力范围，要求审批、短时授权、隔离、取消和审计；采集节点标签不授予 root、命令或自更新权限。

## Non-goals

本次仍不实现或发布 Agent 容器镜像、Kubernetes DaemonSet、自动升级、滚动发布、签名分发、凭据轮换/配置租约或远程智能执行，也不对任何实际主机进行部署。enrollment/activate、节点 control/data 凭据和脚本基线已实现；当前中心侧 AI 代码任务不等于 Agent 已能运行 AI 指令。

## Success criteria

- SC-001 五份设计/运维文档区分可执行现状、待实现设计和已知验收缺口，并能追溯到源码或迁移验收。
- SC-002 独立生命周期、目录权限、身份持久化、离线容量、升级事务边界和容器网络均有明确决策。
- SC-003 实施任务覆盖凭据、发行可信度、健康门槛、Linux 双架构验收和可恢复升级，尚未实现项保持未勾选。
- SC-004 读者不会误用中心镜像作为 Agent，或把采集任务/Key 解释为远程任意执行授权。

## References

[设计](plan.md) · [契约](contracts.md) · [任务](tasks.md) · [部署指南](../../docs/agent-deployment.md) · [Node Agent 验收](../007-node-runtime-migration/agent-validation.md)

## US6 脚本安装与节点凭据绑定（P1）

管理员在“节点助手”中为一台主机生成一次性安装会话。页面给出固定版本、架构和中心地址的安装脚本；短期引导凭据只在页面生成时显示一次，不进入 URL、命令行参数、环境变量、shell 历史或普通日志。运维在目标主机以 root 运行脚本，凭据通过交互式隐藏输入或权限为 0600 的 stdin/FD 文件传入。脚本完成预检、包校验、注册、配置写入和服务健康检查后，中心把该节点标为已激活。

Acceptance: 安装会话只能绑定一个新节点，过期、撤销、重复使用或不同主机重放都会被拒绝；安装重试使用同一个 install nonce 时不会创建重复节点。中心显示 enrollment、激活和最近心跳状态，管理员可以撤销或轮换单个节点凭据。脚本失败不会删除已有节点的数据目录或凭据；新安装产生的未激活凭据可清理并重新生成。

## US7 凭据轮换、撤销与恢复（P1）

每个已激活节点拥有中心签发且绑定 `agent_id` 的控制凭据；数据上报凭据与控制权限分离，本地 SDK 的 `local_token` 继续独立。管理员可以在节点详情中撤销或轮换凭据。Agent 在凭据接近过期时使用旧凭据申请轮换，原子写入新凭据并确认后才切换；短暂重叠窗口用于处理进程重启，撤销操作立即拒绝所有旧凭据。

Acceptance: 中心只保存凭据摘要，诊断、审计和安装输出不包含秘密；同一凭据不能用于另一 `agent_id` 或另一中心。撤销阻止新的控制拉取、心跳和数据上报；断网时节点可继续本地缓存任务，但不应把撤销误报为已停止，恢复联网后立即失效。节点重新安装需新的引导会话，不能通过复制 `identity.json` 或旧 token 冒充原节点。

## Additional requirements for scripted enrollment

节点安装页已把新接入改为管理员创建的 enrollment 会话/一次性 token；`config.key` 仍作为旧节点兼容路径，长期数据上报 Key 不参与新节点的 control credential 签发。完整的旧 Key 收敛仍由 T035 负责。

- FR-013 安装脚本默认采用固定版本和 HTTPS；脚本必须校验中心地址、架构、包完整性及最低 TLS 要求，不默认执行未校验的 `curl | sh`。
- FR-014 引导会话由管理员创建，包含 `enrollment_id`、目标中心、可选初始任务标签、允许架构、作用域、过期时间和单次使用限制；默认短期有效（建议 15 分钟，可配置上限 24 小时）。
- FR-015 引导凭据只用于兑换节点凭据，不得调用控制、数据、管理员或远程执行 API；兑换按 token 与 `install_nonce` 原子去重，丢包重试不会产生第二节点。
- FR-016 Agent 首次运行生成本地密钥材料并提交 `install_nonce`、版本、架构和最小主机元数据；中心签发绑定 `agent_id` 的控制凭据和独立数据凭据。服务请求必须同时证明凭据与节点绑定，不能信任请求体单独提供的 `agent_id`。
- FR-017 凭据按 audience/scope、创建时间、过期时间、撤销时间和轮换前后关系建模；服务器只保存不可逆摘要，完整秘密只在兑换/轮换响应中返回一次并由 Agent 立即安全落盘。
- FR-018 凭据轮换必须幂等且可恢复：新凭据写入临时文件并 fsync 后原子替换，确认成功后旧凭据进入短暂 grace 状态；撤销或安全事件可立即使全部凭据失效。
- FR-019 安装失败、服务健康检查失败或用户取消时，脚本应停止新服务并撤销/使 pending enrollment 失效，保留原有节点状态；对于已有节点升级不得重新注册或覆盖身份。
- FR-020 中心提供按节点查看状态、撤销、重新发起 enrollment 和审计的管理能力；撤销、轮换、重新绑定和激活事件不得记录 token 原文。
- FR-021 凭据撤销与配置租约分开建模；在实现配置租约前，文档和 UI 必须明确离线节点无法即时停止旧缓存任务。实现后应以有限租约使断网节点在到期后停止需要中心授权的采集任务。
- FR-022 新控制路由（注册后的心跳、配置拉取和节点状态）必须校验绑定节点的 `control_credential`，不能继续把 `config.key` 或 `data_credential` 当作控制授权；旧 `config.key` 仅保留明确标注的兼容迁移路径，不能借此创建新绑定节点或伪造任意 `agent_id`。发行包应通过预置受信文件或签名发行渠道取得，enrollment token 不隐式扩大下载权限。

## Script enrollment acceptance checklist

- A1: 页面生成的安装会话只显示一次，浏览器刷新不会再次显示完整 token；用户可撤销未使用会话。
- A2: 交互式和 stdin/FD 两种安装方式都不会把 token 出现在 `ps`、shell history、URL、安装日志或诊断导出中。
- A3: 同一 `install_nonce` 的请求重试保持一个 enrollment 和一个 `agent_id`；不同 nonce 或第二台主机重放被拒绝。同 nonce 重试保持一个 enrollment 和一个 agent_id，并轮换后重新返回 bootstrap secret。
- A4: 激活前服务健康检查失败会回滚本地配置链接，pending enrollment 依赖短期过期（显式 abort 待实现）；激活后启动失败需管理员撤销节点凭据。已有节点升级保留原 token、identity、队列和配置。
- A5: 管理员撤销后，中心拒绝该节点新的控制/数据请求；轮换后只有新凭据有效，旧凭据在 grace 窗口外拒绝。
