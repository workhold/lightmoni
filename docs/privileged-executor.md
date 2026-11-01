# 主机执行权限：普通 Agent 与独立运维执行器

> SDD060 基础权限与统一维护已由 SDD080 扩展到受管主机运维。应用、网站、Compose、证书、备份和制品发布需要单独批准默认关闭的 `operations.managed.v1`；批准的程序和挂载可控制整台主机。旧业务数据必须先按[离线接管步骤](../specs/080-executor-managed-operations/migration-runbook.md)审阅迁移。当前边界见系统设计第80章与 [SDD080 验收](../specs/080-executor-managed-operations/validation.md)，仓库实现不代表线上已升级。

规格、接口与实施顺序分别见 [spec](../specs/060-privileged-executor/spec.md)、[contracts](../specs/060-privileged-executor/contracts.md)、[tasks](../specs/060-privileged-executor/tasks.md)；系统联动入口见 [系统设计第 60 章](system-design.md#第60章-主机执行权限与独立运维执行器sdd-060)。

## 1. 结论与驱动目标

保留普通 Agent，新增按需安装的 `lightmoni-executor` root 服务。前者负责监控、拨测、日志、普通脚本和遥测；后者用独立身份接收中心授权的高权限任务。两者都主动出站，不要求主机开放入站端口。

高权限能力分为受限容器、显式提权脚本和高信任受管运维，分别授权且默认关闭。受限容器仍不开放挂载、端口或任意 command；受管运维按既有管理员批准的应用、网站等资源配置运行固定适配器；一次性提权脚本审阅确切代码与 root 身份。其他系统账户和持续定时提权属于后续独立功能。任意 root 脚本与受管运维可控制整机，不能当作沙箱。

需要 root 的是引导安装和特权执行器。登记主机不必强制 root 用户名；实际 UID 为 0，或具备所需免交互 sudo 权限的 SSH 账户均可。SSH 账户不会成为普通 Agent 的日常运行账户。

用户只登记一套 SSH 登录账户。安装器自动创建普通 `lightmoni-agent` 系统账户；独立执行器使用系统已有的 root，不创建另一套 root 登录账户，也不要求用户登记第二份密码。它通过独立平台身份工作，日常运行不依赖保存的 root SSH 密码。

提权任务进程就是以操作系统 root 账户运行（UID/GID 0）。“进程”表示程序，“root账户”表示运行身份；这不是两个互斥方案。普通 Agent 与普通任务继续以 `lightmoni-agent` 运行。

## 2. 开源参考与 ADR

| 参考 | 已核对的官方行为 | 借鉴与取舍 |
| --- | --- | --- |
| 1Panel v2 | [安装器检查 EUID=0](https://github.com/1Panel-dev/installer/blob/aa4a6bbf24ae0fd938b32294672f5086f940e483/install.sh#L427-L432)，[Agent unit 无 User/Group](https://github.com/1Panel-dev/installer/blob/aa4a6bbf24ae0fd938b32294672f5086f940e483/initscript/1panel-agent.service#L6-L22)，[默认直接连接 Docker Unix socket](https://github.com/1Panel-dev/1Panel/blob/7f4c5039820343b1bfb28b9ffbbce004a10e7ac8/agent/utils/docker/docker.go#L29-L35) | 参考完整主机运维覆盖；不照搬整个 Agent 常驻 root，因为 LightMoni 普通任务允许用户脚本 |
| Cockpit | [普通/特权 bridge](https://docs.cockpit-project.org/cockpit-guide/latest/guide/privileges.html)，[root bridge 与私有 IPC](https://github.com/cockpit-project/cockpit/blob/f00c23a2b067d0dbdc63140867e1887b84115655/src/cockpit/superuser.py#L72-L112)，[提权路径](https://github.com/cockpit-project/cockpit/blob/f00c23a2b067d0dbdc63140867e1887b84115655/pkg/shell/manifest.json#L38-L70) | 借鉴分进程、UID 和显式提权生命周期；它主要在建立特权 bridge 时授权，允许通用 root 进程，不是逐任务有限授权的现成实现 |
| Docker Socket Proxy | [按 API 区段及方法过滤](https://github.com/Tecnativa/docker-socket-proxy#grant-or-revoke-access-to-certain-api-sections) | API 过滤可减少暴露，但不能证明某次 create 的 mount、namespace 和资源归属安全，不能替代业务级参数授权 |

决定不采用以下捷径：普通 Agent 加 Docker 组、给 socket ACL、将 socket 只读挂载后当成只读 API、开放 `sudo docker *`、对整个 Agent 改 root。Docker daemon 权限通常可转为宿主 root；上述做法还会把权限传给同 UID 的普通脚本。rootless Docker 是另一种运行环境，不等于能接管现有 rootful Docker，本期不混用。

## 3. 当前实现与后续迁移接缝

当前安装器支持 root 或 `sudo -n` 引导，创建 nologin 专用账户。普通 systemd unit 设置 `User/Group=lightmoni-agent`、`NoNewPrivileges=true`、`ProtectSystem=strict`，清空 Docker 附加组与 Linux capabilities，写入范围限于 Agent 数据目录。独立 `lightmoni-executor` root 服务使用另一份身份、策略、journal 和维护锁，不通过 sudoers、Polkit 或普通 Agent 的本地命令转发获得权限。

普通脚本和 Agent 同 UID，可读取 Agent 自身配置/凭据，环境变量清理不是操作系统沙箱。中心与普通 Agent 已共用严格的只读 capability/action 配对白名单；自报 capability 不能放行旧写任务，旧 operations 私有正文和制品入口返回410且不解密。root job 的领取、正文、事件和结果要求独立签名主体，普通 control/data 身份无权访问。

| 接缝 | 当前边界与后续工作 |
| --- | --- |
| `server/agent-jobs.ts`、`server/task-center.ts` | 已强制分流执行主体；root 数据接口独立 audience，保留租约、序号、幂等和 unknown |
| `server/service-deployments.ts` | 旧制品执行通道已关闭；受保护预检、current、systemd 和业务回退需后续受管 profile |
| `server/operations.ts`、`ops/store.ts` | 未迁移业务写入口在创建前拒绝；人工操作、自动协调、换证和恢复须逐个接入新授权 |
| `agent/jobs.ts`、`agent/executor.ts`、`agent/operations.ts` | 普通 Agent 已拒绝旧特权动作，不能兜底执行 root job；旧适配器库仅供后续实现复用 |
| `operations/platform.ts` 与 containers/websites/certificates/backups | 最小容器七动作已落地；网站、证书、完整 Compose、systemd 和备份 profile 仍需单独审计与实现 |
| 安装、SSH 维护、更新/回退、卸载器 | 已实现首次安装及唯一维护入口的 upgrade/rollback/repair/uninstall，保护身份、策略、服务和 journal，失确认只读核对 |

`hook.run` 具有任意脚本语义，不能被结构化证书/网站操作顺带提权；关闭的旧业务入口不会因此继续派发。独立普通脚本仍使用普通账户；需要 root 时须另建提权脚本并重新审阅。未迁移业务操作返回 `privileged_profile_not_implemented`，不能静默换成 SSH、Docker 组或 root Agent。

## 4. HLD：执行主体独立，授权与记录统一

```mermaid
flowchart TB
  User[管理员 / 平台 AI / 外部 MCP] --> Task[中心任务与运维提案]
  Task --> Auth[批准计划 / 权限策略 / 精确单次授权]
  Auth --> Jobs[统一执行记录与主体路由]
  Agent[普通 Agent / lightmoni-agent] -->|control：仅普通任务| Jobs
  Executor[root 执行器 / 独立出站身份] -->|签名请求：root lane| Jobs
  Jobs -->|签名计划与在线许可，响应返回| Executor
  Agent --> Normal[监控 / 普通脚本 / 遥测]
  Executor --> Policy[root 本地策略与持久 journal]
  Policy --> Docker[受管容器结构化操作]
  Policy --> Script[已明确批准的提权脚本]
```

图中双向交互通过执行器主动 HTTPS 请求及响应完成，不表示中心入站连接主机。没有普通 Agent 到 root 的通用本地命令入口，首期也不设置本地 UDS。root 执行器没有 SDK Key、模型 Key 或 SSH 凭据；遥测仍由普通 Agent 独立上报，SDK 直报不变。

中心仍是模块化单体。根追踪采用既有 task run，root job 保留统一任务 lineage、发起者、批准者、计划快照、执行主体和结果。执行器使用独立授权与任务状态，复用租约、幂等和 unknown 的状态机制，不经普通 Agent job 队列承载 root 命令。历史 ops run/deployment 与 agent job 关联用于查询和审计，不表示旧业务执行协议仍可用。

root 执行器使用独立 audience 与自己生成的 Ed25519 私钥。它自行领取、下载、验签、取许可和提交签名回执；普通 Agent 的 control/data credential 对上述 root 接口无权。中心将 capability 作为观测，实际准入同时要求当前主机绑定、执行器身份、安装代次、服务端授权和本地策略。

### 4.1 同一代码库、同一发行包、两个运行角色

产品仍是一套 LightMoni Agent。一个版本化发行包提供普通 agent 与 privileged_executor 两个固定入口，分别由 systemd 以 lightmoni-agent 和系统已有 root 启动；使用相同源码、构建和发布流程，不复制出两套 Agent 实现。两种服务可独立启用、保留各自活跃版本与兼容性检查，共享的不可变代码及全部路径祖先必须由 root 拥有，不能从普通 Agent 可写目录加载 root 模块。

共享模块包括协议/schema、任务状态机、幂等与 journal 实现、制品下载/摘要校验、有界进程运行组件和可复用操作适配器。独立组合根注入严格类型的 ExecutionContext（执行主体、身份提供器、策略、状态目录、时钟和允许能力）；同一动作复用实现，入口分别强制鉴权和白名单，不能因共用函数省略高权限 grant。journal代码可以复用，文件、锁与凭据实例不能共用。

共享状态机机制，保留脚本退出码、部署健康验证等各自业务终态规则。共用进程组件的洁净环境、超时、输出和尽力终止机制，profile固定差异；文件写入/切换等非command副作用也必须经过路径/资源策略，不能只保护spawn。ExecutionContext类型用于防误用，真正权限边界仍是OS身份、root文件所有权及中心/本地验权，不能靠isRoot布尔值放行。

操作系统权限来自进程实际 UID/GID/附加组，不来自 SSH 密码、平台 token 或 role 字符串。普通角色常驻运行（run/轮询/采集）以 UID=0 启动应在创建 Agent/runner 前拒绝；version/check/configure 等固定离线管理命令仍可由安装器以 root 执行。特权角色必须实际 UID=0、持有 root 私有执行器身份并验证本地策略，否则拒绝。改密码、改 role 参数或拿普通 control credential 都不能升级权限；使用 root 启动完整普通 Agent 也不作为支持的部署方式。复用的是代码和执行原语，各角色暴露的能力与授权边界仍明确分开。

两个 systemd unit 分别声明文件写入范围、子进程和资源策略。普通 Agent 的 ProtectSystem/ReadWritePaths 不能直接只改 User 后用于 root 执行器；执行器需要按已批准 profile 明确的受管路径和运行单元管理能力，不能用 UID=0 掩盖沙箱配置不匹配。

公共持久化契约已收紧：root任务的journal写入/fsync失败即禁止副作用，损坏状态不能当成无任务，unknown上报失败不能自动clear或解除fence；不能沿用普通runner的宽松错误处理。两角色分别保存current/previous/fingerprint与回退兼容性，普通Agent当前路径不能充当执行器版本状态；当前各自保留受管发行目录，GC/卸载不能越过另一角色的目录与状态。

## 5. 登记、预检与界面

登记表单用户名旁使用简短说明：**“安装 Agent 需要 root，或支持免交互提权的 sudo 账户。登录账户用于安装和恢复，Agent 使用独立账户运行。”** 不添加永久保存凭据的大段警告，不改变已有保存期限选择。

| 位置 | 行为 |
| --- | --- |
| 登记主机 | 填地址、名称、SSH 账户和凭据，可先保存；登记不自动授予执行器能力 |
| SSH 预检 | 返回 root / sudo_noninteractive / unavailable / unknown；核验 UID、实际 sudo 执行、Linux/systemd、架构、依赖、绑定与现有安装 |
| 安装审阅 | 列出普通 Agent 账户、是否新增 root 执行器、所开能力、固定文件/服务及变更范围，管理员明确确认 |
| 主机管理通道 | 分别显示 Agent 在线、执行器在线、容器管理授权/就绪、提权脚本授权/就绪、最后验证时间 |
| 已有主机开启能力 | 新建权限计划，通过 SSH 引导安装/修复；有可用执行器时可用其固定策略管理动作，新增能力仍需管理员审批 |
| 权限不足 | 主机登记和普通 SSH 终端可用；安装/开启按钮显示具体阻塞原因，不把 SSH 可登录等同可安装 |

预检绑定 endpoint、host key、machine/credential revision 和有效期；引导前再次检查，字段变化废弃旧计划。免交互 sudo 必须覆盖固定引导/维护所需命令；不能只用 `sudo -n true` 推断整个安装可提权。首期沿用现有受控安装器的实际 root/sudo 引导边界，不自动写 sudoers；只允许少量命令的 sudo 策略若不覆盖安装器，则明确不支持。需要密码的 sudo 首期不支持，不能暗中使用 SSH 登录密码。

SSH 凭据可按既有 6h 等期限保存或用户选择永久；到期不停止已运行 Agent/执行器，但再次 SSH 安装/恢复需要有效凭据。权限开关不是保存 root 密码。执行器不可用时也不自动重用长期 SSH。

## 6. LLD：引导、目录和信任根

首次启用通过已登记主机的 SSH 固定安装器执行：审批冻结机器、Agent 安装代次、发行摘要、能力与策略；安装器以 root 写入 root 所有程序/配置，生成 executor key，使用一次性、短期、预绑定的独立 enrollment 注册公钥。enrollment 仅 stdin/FD 传递，不用 Agent control 换取 executor 身份，不复用 Agent enrollment。

| 路径/状态 | 所有者与用途 |
| --- | --- |
| `/opt/lightmoni-executor/releases/`、root launcher与 unit | root:root，版本化程序与固定入口；普通 Agent 不可写 |
| `/etc/lightmoni-executor/` | root:root 0700；中心实例/HTTPS origin、Ed25519 信任公钥、executor 私钥和本地策略，秘密文件 0600 |
| `/var/lib/lightmoni-executor/` | root:root 0700；身份、最高 policy generation、防重记录、journal、writer fence与资源清单 |
| 独立 stage/work/config/release 目录 | root 控制全部路径祖先与入口，不使用 Agent 数据目录或任务自报本地路径 |
| 普通 Agent 目录 | 继续仅供普通任务/采集，不放 root 的锁、凭据、Compose/Nginx/证书配置 |

执行器只访问固定中心实例与允许的 HTTPS origin，拒绝重定向、URL 凭据、任意下载目标和调用者 Docker context。信任根由审批过的 SSH 引导安装，普通 control 不能替换。身份轮换、中心信任 key 轮换和灾难恢复属于后续功能，必须证明原信任或重新 SSH 引导；更换中心实例不能自动接受旧票据，恢复备份不能把已消费许可当成新许可。

systemd 使用独立 root 服务，收紧文件写入范围、网络、进程与资源限制；结构化适配器不执行任意 shell。提权脚本单独启动每次运行的受管子单元，不能把 root 脚本注入长期执行器主进程。系统沙箱选项按实际能力验证，不用一份虚假的严格模板宣称能阻止已授权 root 脚本影响主机。

## 7. LLD：计划签名、在线许可和回执

中心签名不可变执行计划；签名覆盖完整目标、执行主体、能力、资源 revision、请求及制品摘要、授权与安装代次、租约、期限和最大运行时间，具体字段见 contracts。使用固定 Ed25519 JWS 验证原始 payload 字节，禁止算法协商、远端 key URL、重复 JSON 字段及未知参数。

执行器请求另由本机私钥签名 method/path/body digest/request_id/时间/安装代次。中心对请求 ID 与摘要持久去重；重放相同 claim 返回相同结果，不能获取新租约。身份绑定、私有 payload、制品、events/result、reconcile 都执行同样的主体校验，不能只保护 claim。

```mermaid
sequenceDiagram
  participant C as 中心授权与任务
  participant E as root执行器
  participant J as root持久journal
  participant H as Docker或脚本运行单元
  E->>C: 独立签名claim
  C-->>E: 签名计划与固定payload摘要
  E->>E: 验签/本地策略/路径/账户/资源检查
  E->>J: 持久任务摘要、step与nonce
  E->>C: 在线申请该step start permit
  C-->>E: 当前授权与租约有效的30秒许可
  E->>J: fsync intent并消费许可
  E->>H: 开始固定动作或已批准脚本
  H-->>E: 有界结果及现场观察
  E->>J: fsync结果；不确定则unknown并保留锁
  E->>C: 独立签名事件与最终回执
```

每个新副作用步骤开始前在线兑换单次、最长 30 秒的 start permit；默认执行租约 45 秒、每 15 秒续租。中心在兑换时重查授权者、具体批准、主机绑定、策略代次、有效期和互斥。许可有最多 30 秒的撤权启动窗口，不能承诺断网后即时收回已签发许可。失联不开始新步骤；已经进入 Docker daemon 或已启动脚本的副作用可能继续，超时不等于撤销完成。

为保证上述上限，请求签名的 60 秒时差容忍不用于 permit。发出该 nonce 请求前，执行器按包含系统挂起时间的 Linux 单调时钟设置最长 30 秒 deadline，收到响应只能缩短而不能重新开始计时；过迟响应、无法证明时间、重启或新 boot 废弃未消费许可。租约/运行截止也用单调计时，不能通过墙钟回拨或慢钟扩窗。

先持久 intent 再产生副作用，结果先落 journal 再回传。相同 job/摘要返回原记录，不同摘要拒绝；重启、daemon 超时、丢确认进入 unknown，保留写 fence，先只读核对后解除。不能用 PID 消失、Agent 空闲或 lease 到期证明外部副作用未发生。最终结果通过执行器身份提交，旧代次/迟到回执不能覆盖 unknown 或新 revision；根任务同时展示执行器声明和独立健康观察，二者不是同一证据。

互斥由中心 machine/lifecycle/resource 冲突域和 root 本地持久 fence 共同实现。提权脚本首期独占整机写 fence，排除受管容器/部署/维护并发；普通脚本仍非可信沙箱，不宣称能阻止其自行制造外部并发副作用。

## 8. 容器管理：有限能力，而非原始 Docker 权限

启用 `container.managed.v1` 需要中心授权、本地 root 策略、执行器在线、固定 Docker daemon/socket 与依赖全部就绪。普通 Agent 不获得 Docker 组、socket ACL 或 proxy。执行器直接使用固定 Unix socket 的 Docker Engine API，中心与 root 端分别校验结构化参数。

首批仅开放 `list/pull/create/start/stop/restart/remove` 七个动作。list返回脱敏清单/状态，其余变更绑定精确计划与逐步许可；镜像固定不可变 digest 与架构。当前没有 Compose、容器日志读取、卷、宿主绑定、发布端口、任意 command/exec 或私有注册表凭据接入能力，不能据此部署用户完整业务服务。

create固定使用65532:65532账户、只读根文件系统、无网络、无挂载/卷/端口、无附加capabilities，以及固定CPU/内存/PID/日志存储上限；拒绝带VOLUME声明的镜像。参数白名单拒绝privileged、host PID/IPC/network、设备、cap_add、安全绕过、任意runtime及未知字段。start/restart再次核对实际容器配置，不能只按HTTP method/API prefix判断安全。

资源归属以root清单中的daemon identity、Docker不可变ID和平台resource/revision为准，不能只信标签或名称。已有非受管容器只返回脱敏清单，不接管、不删除；受管容器也不允许通过namespace借用或关闭宿主隔离获得额外权限。依赖或安全检查不满足时阻塞，不自动放宽配置。

Compose、容器日志、私有注册表、卷、端口、受管宿主绑定及现有容器接管均须后续独立profile审计和验收。后续卷必须限定受信local driver，禁止driver_opts/plugin把任意bind伪装成named volume；宿主绑定入口及全部路径祖先必须由root保管并防止链接替换，不能直接消费Agent可写文件。

网站网关的host network、证书发布和受管systemd服务也属于后续profile。旧业务入口当前已关闭，不因保留适配器库而可用；未来部署若可修改root ExecStart，权限等同任意root脚本，不能冒充受限普通发布。

## 9. 提权脚本：由用户批准确切代码与身份

普通任务默认“以 Agent 账户执行”。首批提权脚本只支持root账户，展示完整代码/上传文件、解释器、参数、独立临时工作目录、显式环境、目标主机、超时和输出限制。提示一句：**“此脚本将以 root 操作系统账户运行，可修改整台主机，请确认代码及目标主机。”** 当前不提供其他系统账户或秘密引用字段，凭据不得填入代码或普通环境字段。

需要同时满足主机启用 `script.elevated.v1`、当前管理员有批准权、精确单次计划获批和执行器在线。容器管理开关不隐含授予脚本提权。MCP/平台 AI 可生成草稿和解释变更，但不能替用户点击批准，不能通过普通任务写 `sudo` 自动升级；执行失败也不自动换身份。

批准冻结代码原始字节SHA-256、解释器固定ID与摘要、参数、显式环境摘要、private cwd profile、固定machine/executor、root UID/GID/补充组、超时/输出上限与策略代次。实际UID为0才是root，不能只看账户名；执行前核对账户映射、组和解释器变化，不接受模型自由传UID、组或任意shell路径。

root自有staging保存代码，专用运行单元以核对过的User/Group/补充组启动固定解释器，先清理继承环境、设置工作目录和资源限额，避免继承SSH/执行器/中心密钥。执行器不把自身私钥放入子进程FD/env；代码和解释器在实际启动前再次核对，不能只信审批时摘要。

脚本stdout/stderr可能包含未知秘密，按独立敏感正文加密保存，合计每运行最多256KiB，仅显式授权管理员查看，不自动进入普通日志、遥测或AI/MCP上下文。元数据回执只含固定白名单字段，不能保证任意脚本输出不含秘密。容器日志读取尚未开放，不能把敏感输出查看入口解释为任意容器日志接口。

每台主机的 grant 在中心事务中从 reserved(run_id) 到 consumed，不可复制到另一运行；enqueue、claim、start、renew 都要求有效 grant。执行器先持久消费再启动，失败、超时或 unknown 不因换 nonce 自动重跑。批量审阅枚举每台主机，各自生成一次性授权。默认清除 NODE_OPTIONS、BASH_ENV、LD_PRELOAD 和用户 PATH 等隐式启动环境；解释器/运行时版本摘要列入计划。相同脚本文本仍可能调用已变化的程序、依赖或网络内容，代码摘要不能保证全部行为可复现。

后续若支持指定非root账户，必须独立审阅真实UID/GID/附加组、账户工作目录与只读脚本传递方式，不得放宽整个root状态目录或泄露继承FD；docker组等可拥有接近整机权限。该账户扩展当前未开放。

**批准 root 脚本就是信任这段代码有整机权限。** 它仍可能读取主机秘密、改变 root 文件、Docker、systemd、执行器和审计。cgroup、超时和签名不能阻止恶意 root 逃逸、派生后台副作用或伪造现场证据；平台记录批准与已有回执，但不能保证被批准脚本破坏后的主机可信。结构化容器操作的限制不适用于此模式，不能对两者作同等安全承诺。

首期只支持立即一次性提权任务，拒绝 at/interval/cron 和自动重试；再次执行需要新尝试和明确批准，unknown 必须先核对。有日历计划的需求在后续阶段增加“持续提权授权”：绑定不可变代码、固定主机/账户、允许动作、时间表、有限有效期和最大次数，每次执行在线重验；代码/环境/身份/目标变化即暂停并重新审批，标签新增主机不自动进入授权。关闭能力、授权者失效或到期立即停止新派发，不能把普通定时任务静默转成 root。

## 10. 开关状态、撤权与生命周期

`requested/authorized` 表示用户意图和中心许可，`effective` 表示最近执行器验证结果。ready 必须是当前身份/代次/策略的签名新鲜观察；失联、过期、daemon 更换、文件被外部修改等分别为 unavailable/blocked/unknown，UI 不能仅凭开关为“开”显示可用。

首次启用通过executor-bootstrap计划→审批→SSH安装→独立注册→写入策略→执行器验证→ready；结果未知时保留原记录，不猜测缺席后重装。已有可信执行器时，经管理员审批的固定策略管理动作应用更高代次策略并验收，不重新enrollment，也不需要仍有效的SSH凭据。唯一executor-maintenance入口已支持upgrade/rollback/repair/uninstall；repair要求完整相同身份、有效journal及可证明的中断阶段，不能用于重新注册或重建丢失状态。维护与恢复使用有效SSH凭据，一次更新不自动启用新capability。

关闭先提升中心policy generation、停止新派发并取消未开始任务，再等待执行器持久应用新策略、处理在途结果后回执；未确认显示disabling/unknown。已签许可有前述短期窗口，已运行任务不能假定已停止。

关闭容器权限不停止/删除业务容器，不重启 Docker；关闭提权脚本不强杀未知副作用。已运行任务按固定停止/超时协议请求取消，未核实完成则保留 unknown/fence。策略关闭后执行器可保留仅用于身份/状态/策略和恢复的出站循环，没有通用命令入口；之后启用仍需新审批。单独移除执行器通过生命周期计划，需确认无在途未知任务并保留必要审计。

安装/更新/主动回退/显式恢复覆盖执行器程序、unit、静态配置兼容性与持久状态保护；独立执行器失败不自动回退或重放。切换前冻结并核对在途/unknown；回退只恢复程序/unit及兼容静态配置，不能恢复旧 journal/fence、防重、已完成运行、已消费授权、身份/密钥撤销水位或最高策略代次。上述持久状态可备份但不得随程序回退回滚；状态缺失或恢复旧备份必须重新建立中心 fencing 代次并核对现场，不能正常模式自动初始化后继续写。旧版本不理解当前状态/策略则 fail closed，不能降级授权。普通 Agent 更新不无故重启执行器，执行器更新也不重启业务容器；不兼容协议先停派，再升级。

标准、SSH恢复和离线卸载器只清理平台拥有的服务/入口/权限与密钥；保留遥测/身份数据选项不等于保留宿主权限。手动离线卸载不能声称中心身份已撤销，中心失联时状态 unknown，管理员后续撤销。默认不删除业务容器/卷/发布数据，清理业务资源必须另列精确目标审批；root journal有未知写入时不得无声丢弃证据。外部管理员添加的组/ACL标记 external，不自动删除，也不能宣称平台关闭已移除全部外部权限。

## 11. 分期与完成定义

本PR已实现root/sudo预检、独立身份、全接口主体隔离、计划/许可/防重、root journal/fence、完整维护入口，以及最小容器七动作和一次性root脚本UI；每台主机只有实际验收通过才显示ready。网站、证书、完整Compose、systemd发布、备份、自动协调、指定其他账户及有期限定时提权仍是后续独立功能，逐个审计和验收。

目标迁移要求：中心升级不能让旧 Agent 自动获得权限。已有主机显式启用/升级后才能进入新 lane；未迁移旧高级操作 fail closed，不保留普通 control 领取特权 payload 的旁路。普通监控继续运行。

中心与普通Agent共用严格只读capability/action配对白名单，旧写队列未领取则取消、已领取则unknown；旧私有operations/artifact固定410且不解密，未迁移业务profile创建前409明确阻断。旧API执行兼容已删除，纯适配器库可供后续profile复用。独立执行器生命周期及最小容器/脚本UI见系统设计60.10与SDD060 completion；网站/证书/完整Compose等后续业务迁移不通过保留旧control执行来兼容。

验收包括 root/免交互sudo/交互sudo/无提权、凭据期限、默认关闭、伪造普通control/UID/capability、请求/签名重放、计划篡改、旧代次、危险Compose、外部容器、脚本身份与快照变化、断网/重启/daemon超时、关闭/升级/回退/保留数据卸载。真实 Linux 与 Docker 实测独立记录；已完成与未完成项目分别记录在 SDD060 tasks 和 validation，不用设计检查替代实际功能验收。


## #64 收口后的实现基线

唯一executor-maintenance支持upgrade/rollback/repair/uninstall，完整契约见[completion](../specs/060-privileged-executor/completion.md)。同catalog不可变程序及精确保留previous、state_schema=1、root固定监督器、bootstrap/lifecycle/writer锁、完整身份/journal校验和持久阶段记录共同约束切换。activation在worker启动时只读一次并签入心跳；中心以本次operation的receipt与精确activation确认新启动，同版本旧进程心跳无效。显式只读恢复可依据完整持久阶段和同activation签名心跳确认最后回执落盘中断，保留原始状态，不重放写；真实执行unknown不自动解除。

普通Agent安装/升级/回退不恢复旧Docker组或低端口能力。仅精确清理本平台root拥有、字节匹配的历史20-lightmoni-docker.conf；未知drop-in及外部组/ACL保留拒绝。高权限旧主unit不能作为回退目标，失败恢复安全停服并保留证据，不伪造原fingerprint或声称完整回退成功。最小结构化容器UI只开放七个已有动作，敏感输出显式查看；它不等于完整业务容器部署profile。
