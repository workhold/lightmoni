# SDD 021：AI 辅助 SDK 打点与业务部署

## 状态

- 状态：部分实现（受限插桩 apply、Agent 执行协议与部署回执状态映射）、待评审
- 日期：2026-10-23
- 关联总设计：[`docs/system-design.md`](../../docs/system-design.md)
- 前置设计：SDD 012（SDK 上报路径）、SDD 014（Agent 接入）、SDD 017（SSH 引导）、SDD 020（架构双端同步）
- 架构影响：是。新增源码改写边界、业务制品与部署状态、Agent 执行任务和中心/Agent 控制路径。
- Doca 同步目标：[LightMoni 系统设计基线](https://doca.heyphp.com/#/r/2902a80f-c592-414e-9aed-64fe19f2ed53)。合并前必须按 SDD 020 读取最新版本、保留原生图块、写入后回读文本及节点连线。

### 当前切片边界（实现事实）

本 SDD 描述的是完整目标能力；当前分支只实现了其中的可审阅计划切片，不能把它描述为已经可以自动部署业务：

- `runtime/src/assistant/instrumentation.ts` 提供只读、启发式扫描器、受限的结构化插桩提案和管理员确认后的安全 apply。提案目前只对可明确定位的 TypeScript/JavaScript 多行请求处理函数生成 unified diff；apply 绑定 `base_revision`，检查路径、符号链接和文件大小并原子写入，仍不执行构建或项目代码。Python、Go、Rust、Ruby 和歧义边界只返回手动步骤。
- `runtime/src/deployment` 已有 `systemd` 纯逻辑适配器和显式 provider registry，并有边界测试；适配器通过服务部署计划生成 typed action 的扩展点，主机动作由 Agent executor 解释。
- `runtime/src/server/service-deployments.ts` 持久化 service/target/release/deployment 元数据和脱敏 deployment events。管理员 `approve` 在 Agent 就绪后要求至少一个 typed action 和带 capability 的 health_check，然后原子创建不可变 Agent job 并推进到 `agent_ready`。管理员可取消未审批计划；已批准计划仅在 Agent job 仍排队时允许原子取消，Agent 已领取后取消请求返回冲突，不宣称远端执行已停止。中心将 Agent 的单调阶段回执映射到部署状态；最终成功必须来自 verifying 状态且含 `health.healthy=true`。未领取 job 过期可安全取消；Agent 端执行取消、租约过期和不完整成功回执均保留 unknown，不推断目标机已恢复或失败。中心后台定期清理 job 过期状态，事件状态与 receipt 在同一 SQLite 事务内更新。
- service target 可请求 Agent 执行只读 systemd preflight。Agent 只检查登记的 unit 与 release directory，返回固定字段的状态快照；中心保存结果，后续部署计划可绑定最近一次通过的快照。该预检不会运行部署动作或 shell，也不包含制品上传/下载，因此部署审批仍会安全拒绝缺少可执行 typed actions 的计划。
- 部署工作台只有在计划明确为 ready 且包含 actions/capabilities 时显示批准按钮。目标需先通过 Agent 只读 systemd 预检，并选择已校验的 ready bundle；缺少预检、制品或执行动作时不能审批。
- `runtime/src/deployment/verification.ts` 已提供中心侧有界健康/遥测证据判定。只读 systemd preflight 已通过 Agent job 检查目标 unit 和 release directory；Agent 回报部署健康检查通过只代表计划内的 Agent 检查，不代表中心已查询 ClickHouse 遥测。受控源码构建、真实 ClickHouse 查询和自动补偿仍未接入；人工确认的 systemd 回滚 job 仅支持恢复已登记的 previous release。
- Assistant 目前提供扫描、只读插桩提案、管理员确认后的插桩 apply、服务列表、部署计划提案和部署状态读取工具。构建、真实部署编排和回滚工具仍未提供；Agent job 的拉取、能力执行和回执由 Agent 运行时独立完成。
- `docker_compose` 目前最多作为目标元数据被登记，尚无对应适配器或执行器；只有注册到 registry 的 provider 才能执行，不能把登记成功解释为 provider 已支持。
- 业务制品与激活契约已在本轮收敛为 `lightmoni-release-v1.tar.gz`：受限 USTAR gzip 包、根目录 `manifest.json` 与可执行 `run` 入口；内容存入中心私有 digest-addressed 目录，Agent 仅能在有效 job lease 下下载。目标 systemd unit 必须预先使用 `<release_directory>/current/run`，Agent 将 `current` 原子切换为 `releases/<version>` 相对符号链接；LightMoni 不改写任意 unit。此契约先于完整构建 worker 实现，当前 status 仍以任务表为准。
- MVP 主机权限约束：release 根目录由 root 创建和持有，属组为 Agent systemd unit 配置的主组 `lightmoni-agent`（建议 `0775`，其他用户只读/遍历），Agent 预检和执行必须校验 UID=0、目录 GID 等于 Agent 主 GID、该组可写且其他用户不可写；Agent 的 systemd 沙箱需通过精确 `ReadWritePaths` 获得该目录写权限。业务服务运行用户不得属于 Agent 组或写入目录。bundle 只放运行所需文件，禁止携带密钥、环境凭据和私钥。真实主机预检需验证该权限组合。

## 背景与问题

LightMoni 已经有 AI 对话、Pi 代码任务、SDK 上报、受管主机和独立 LightMoni Agent，但这些能力尚未组成一条可审阅、可回滚的 onboarding 流程。用户需要在自己的业务服务中添加 SDK 自定义打点，然后将修改后的服务与 Agent 部署到多种运行环境。直接让模型执行 SSH、任意 shell 或生产构建会暴露密钥、产生不可审计的副作用，也无法在服务启动后确认真实遥测是否进入平台。

用户业务可能是 Node/Python/Go/Rust 二进制、解释器进程、Docker Compose 或 Kubernetes 工作负载。部署能力必须按运行方式抽象，不把每种编程语言误当成一种部署协议。SDK 默认直连中心；Agent 是独立运行的节点执行平面，用户可以选择 SDK 经 Agent 的离线队列模式，但本特性不强制安装 Agent 才能使用 SDK。

## 目标

1. AI 能在隔离 workspace 中识别项目语言、框架、现有 LightMoni SDK 和可插入的启动/请求边界，生成可审阅的插桩计划和 diff。
2. 管理员确认后才能应用源码 diff、构建不可变制品或创建部署计划；AI 不能直接改变生产源码、凭据或服务状态。
3. 用统一的 `probe → plan → apply → verify → rollback` 适配器接口承载不同运行方式。MVP 实现 `systemd`，为 Docker Compose 和 Kubernetes 保留扩展点。
4. Agent 安装与业务部署是一个 onboarding 流程中的两个独立阶段：先确保 Agent 就绪，再部署业务；Agent 失败阻断业务部署，业务失败只回滚业务激活，不卸载 Agent。
5. Agent 只执行签名、短时、能力白名单的 typed actions，中心能看到每一步状态、回执、操作者和审计事件。
6. 部署成功必须验证进程健康，并尽可能验证 LightMoni 遥测；只有服务健康而尚未看到遥测时，明确显示“部署成功，遥测未验证”。
7. 所有凭据用途分离。SSH 只用于首次接入、人工维护和救援；Agent 激活后，日常部署通过 Agent control credential/data credential 完成。

## 非目标（MVP）

- 不提供任意远程 shell、浏览器终端自动执行、`npm install`/编译器安装或模型直接使用 SSH 私钥。
- 不在生产 Agent 上修改源码、运行不受约束的构建脚本或访问中心模型 Key；构建在隔离 workspace/受控构建环境完成。
- 不实现所有运行方式。首版仅实现已登记主机上的 systemd unit；Docker Compose、Kubernetes/Helm、CI/GitOps、Windows 和 Serverless 为后续适配器。
- 不把 SDK 上报强制改成 Agent 中转；直连中心和经 Agent 两条模式都保留，用户显式选择，不自动故障切换。
- 不承诺完整 IDE、自动发布流水线、多租户逐字段 ACL 或跨文件事务。

## 角色与术语

| 术语 | 定义 |
| --- | --- |
| 业务服务（service） | 用户希望被打点、构建和部署的逻辑服务，不等同于进程或机器 |
| 服务目标（service target） | 某个服务在一台机器上的运行实例及其部署 provider 配置 |
| 制品（release/artifact） | 由受控构建产生、带版本和 SHA-256 的不可变文件或制品引用 |
| 部署（deployment） | 将一个制品激活到一个服务目标，并记录验证/回滚状态的计划实例 |
| 适配器（adapter） | 把某种运行方式转换为受限 typed actions 的 `probe/plan/apply/verify/rollback` 实现 |
| 插桩计划（instrumentation plan） | AI 对源码的诊断、候选位置、补丁摘要、风险和验证命令；未确认前不改变源文件 |
| Agent job | 中心发给已激活 Agent 的一次有界执行任务，带能力集合、过期时间和幂等 ID |
| 遥测验证 | 部署后用服务/实例标识查询中心目录和遥测，确认至少一条新数据或明确超时 |

## 用户场景

### US-01：分析并添加 SDK 打点

作为管理员，我希望把 Git 工作区或受控项目提供给 AI，让它识别技术栈和已有 SDK，给出最小改动的打点 diff；我可以逐文件查看、拒绝或应用该 diff，并看到它不会读取或提交秘密。

**验收**：没有用户确认时，仓库文件、构建和部署都不变；应用后有 diff 摘要、变更文件、SDK 版本、服务标识和验证结果。

### US-02：准备节点和业务服务

作为管理员，我希望先对机器做 SSH 指纹/权限预检，再生成 Agent 安装计划和服务部署计划，看到这两个阶段的依赖关系与预计动作。

**验收**：Agent 计划未批准不能安装；Agent 未激活时业务部署不可执行；Agent 激活后可独立于业务服务重启和心跳。

### US-03：部署多种服务

作为管理员，我希望按服务运行方式创建部署计划，不需要为 Node、Python、Go、Rust 分别维护一套部署逻辑。

**验收**：systemd 目标能生成明确的 staging、daemon-reload、start/restart、health-check 和 rollback typed actions；不支持的 provider 返回结构化 `provider_unsupported`，不会执行隐式 shell。

### US-04：安全回执和遥测闭环

作为管理员，我希望看到制品摘要、计划 diff、执行状态、健康检查、遥测验证和回滚结果，而不是只看到模型声称成功。

**验收**：每个阶段均有审计事件和幂等 operation ID；管理员确认后可将当前部署 CAS 切回已登记的 previous release，并要求 Agent 回报版本与健康检查证据；没有 previous release、目标版本已变化或结果未知时拒绝盲目回滚/重试；服务健康但无新遥测时显示未验证而非失败。

## 功能需求

### FR-001 源码扫描与插桩计划

- 输入必须来自已授权 workspace 或受控 Git checkout，并通过路径/符号链接/文件大小限制。
- 扫描识别语言、包管理器、框架入口、部署入口、LightMoni SDK 包/版本、配置读取方式和已有打点调用。
- 计划至少包含：服务标识候选、建议 SDK 入口、候选打点位置、每个文件的变更摘要、风险、需要用户确认的假设和验证命令。
- 支持通过语法树/结构化编辑优先；无法安全定位时只输出建议，不生成自动补丁。
- 默认生成直连中心配置；若用户选择 Agent 模式，只生成 endpoint/local-token 引用，不复制 Agent 的中心凭据。
- 应用只能由管理员通过独立确认 API 触发，需校验 workspace revision，防止覆盖用户新修改。

### FR-002 构建与制品

- 构建输入必须是已应用且已确认的 revision；构建环境隔离，构建日志脱敏并限制时长、CPU、内存和网络。
- 制品不可变，至少包含 `service_id`、`version`、`sha256`、架构、来源 revision 和创建者。MVP 文件格式为 gzip 压缩 USTAR `lightmoni-release-v1.tar.gz`，中心与 Agent 限制压缩体积 64 MiB、解包总体积 256 MiB、最多 10,000 个条目；只允许普通文件和目录，拒绝符号链接、硬链接、设备、稀疏文件、PAX/GNU 扩展、重复路径、绝对路径和 `..`。上传和 Agent 暂存都拒绝常见凭据专用路径、私钥/知名 token、URL/DSN userinfo、凭据查询参数、Basic Auth 及跨行配置中的有值凭据字段；扫描使用有界窗口、单次 percent 解码且错误不回显匹配内容。该规则是减少误打包风险的启发式门，不保证识别所有秘密，也不替代构建来源审查；bundle 只放运行文件，密钥必须由目标主机的独立秘密管理提供。
- 包根必须有不超过 64 KiB 的 `manifest.json` 和可执行普通文件 `run`。Manifest schema 为 `{schema_version:1,service_id,version,architecture,source_revision,entrypoint:"run"}`；架构仅为 `any`、`linux-amd64` 或 `linux-arm64`。Agent 校验 manifest 与 release、目标服务、主机架构一致后才可激活。
- 中心制品正文存储于非静态、私有的 content-addressed 目录，SQLite 只记录 release 元数据、摘要、大小和状态。上传接口要求管理员认证、大小限制、摘要复核、原子落盘和不可变摘要；公开 `/downloads` 不得承载业务制品。
- 中心每个运行时进程最多同时处理一个管理员制品上传，准入范围覆盖流式落盘、完整性/格式检查、凭据扫描和 release 状态更新。容量已满时拒绝新请求并关闭连接，不能无限排队。此门控限制并发放大，不消除单个最大制品解析带来的内存峰值；存储配额、引用感知 GC 和流式解析仍需后续实现。
- Agent 只接收 release ID、摘要和 job-scoped 下载接口；下载必须同时验证 Agent control credential、Agent ID、当前未过期 job lease、job action 中的 release ID/摘要和 release 归属。凭据只能放 Authorization/header，不放 URL；下载路径不能接受任意主机 URL。
- Agent 下载后先校验压缩包 SHA-256，再安全解包到 `<release_directory>/releases/<version>`，逐文件使用受控目录句柄和 `O_NOFOLLOW` 原子创建。release 内容不可覆盖；同一 digest 重试幂等。
- 构建失败不得创建可激活 release；同一 digest 重试必须幂等。

### FR-003 服务、目标和部署状态

- 中心持久化 `services`、`service_targets`、`releases`、`deployments`；目标必须绑定一台已登记机器和 provider 配置。
- 部署状态至少包括：`draft`、`preflight`、`awaiting_approval`、`agent_ready`、`staging`、`activating`、`verifying`、`succeeded`、`failed`、`rollback_pending`、`rolling_back`、`rolled_back`。
- 状态迁移由中心校验；Agent 回执只能推进其授权 operation，不能自行把失败写成成功。
- 管理员可以取消未审批的部署或尚未被 Agent 领取的执行 job；Agent 已领取后，中心必须拒绝声称安全取消，执行中断/取消回执统一进入 `unknown` 并要求复核主机。对回滚操作，未知或不匹配的最终回执会将当前操作收口为 `failed`、receipt 保留 `unknown`，避免界面永久显示“回滚中”；只有新鲜安全预检仍证明本次部署版本是 current 时，管理员才能显式创建新 operation 重试。
- 每个部署保存 `requested_by`、`approved_by`、计划 revision、制品 digest、目标快照、开始/结束时间和错误码。

### FR-004 适配器和 systemd MVP

- 所有 provider 遵循 `probe → plan → apply → verify → rollback`，输入输出为 JSON 可序列化的类型，不返回 shell 字符串。
- `systemd` probe 检查 systemd 可用、unit 存在、当前 active/enabled 状态、当前版本和受控 release 目录。
- systemd 服务由管理员预先配置稳定的 `ExecStart=<release_directory>/current/run`；Agent 只校验该固定入口，不修改 unit 文件、环境文件或服务用户。未满足此入口约定的目标不 ready。
- Agent 的 `systemd.probe` capability 仅允许读取 job 中登记的 unit 和 release directory；结果为有限枚举、布尔值、版本标识和固定错误码，不上传原始 stdout/stderr。中心将预检快照绑定到 target 和 operation，并在计划中保留最近一次未过期快照。
- 预检快照缺失、过期或 `ready=false` 时，中心不得生成可审批部署动作；预检通过也不等于部署完成，计划还须绑定 ready bundle 和实际执行动作。
- plan 仅生成受限 actions：暂存制品、daemon-reload、enable/start/restart、HTTP/TCP/systemd-active 健康检查和回滚动作。
- Agent executor 只允许目标登记的 unit、受控 release 目录和允许的健康检查；unit/路径来自服务目标配置而非模型自由输入。
- Agent 对受控目录的检查、制品暂存和版本切换要求 Linux 固定目录句柄与 `O_NOFOLLOW`；其他平台不标记预检 ready，也不执行部署文件写操作。`current` 是指向 `releases/<safe-version>` 的相对符号链接，Agent 通过同目录临时 symlink + 原子 rename 切换；执行前比较计划绑定的 previous version，避免覆盖预检后发生的外部部署。检查 `current` 时不能因 FIFO 等特殊文件阻塞 Agent job loop。
- systemd 适配器必须在不支持的主机/坏快照/摘要不匹配时拒绝计划，不尝试猜测或修正。

### FR-005 Agent 执行与回执

- Agent 通过 control credential 拉取 job，校验 job 签名、受众、过期时间、能力白名单、目标 Agent ID 和幂等键。
- 每次 job 仅执行一个 deployment operation；超时、取消、重启后可恢复为 `unknown` 并由中心重新探测，不重复盲启停。
- Agent 回报结构化事件：`accepted`、`staging`、`activating`、`verifying`、`succeeded`/`failed`，附固定错误码和脱敏摘要。
- 原始命令输出、私钥、密码、中心模型 Key 和环境变量秘密不得回传中心或 AI 上下文。

### FR-006 Agent 与 SDK 联动

- Agent 是独立生命周期；业务退出不停止 Agent，Agent 也不因未部署业务而卸载。
- 用户 SDK 默认直连中心；Agent 模式显式配置本机 endpoint 和 local token，Agent 将批次持久化后用 data credential 上报。
- Agent 内部采集器可以使用与用户 SDK 相同的 SDK 语义/协议，但不要求用户 SDK 必须经过 Agent。
- 部署计划可以验证 SDK 配置存在和 service/env 标识正确，但不能把“Agent 在线”当成“遥测已入库”。

### FR-007 真实健康与遥测验证

- 进程健康检查至少支持 systemd active；可选 HTTP/TCP 检查带超时和期望状态。
- 遥测验证通过中心查询执行器，以 deployment 的 `service_id`、实例标识、创建时间窗口和 batch 约束查询。
- 查询不到数据时分为“等待中/超时未验证”，不将其解释为服务崩溃；页面显示下一步。
- 验证和回滚结果可被 AI 读取，但 AI 不能据此绕过管理员确认。

### FR-008 AI 工具和权限

- AI 只调用只读诊断、生成计划和读取执行回执工具；源码应用、构建、Agent 安装、部署、回滚均返回 proposal/plan 并要求管理员确认。
- 工具参数必须是结构化 ID，不接受任意 shell、任意路径或秘密文本；后端重新校验管理员权限、revision、状态和过期时间。
- 工具输出限制大小并脱敏；模型上下文只包含摘要、固定错误码和必要的 diff，不包含 SSH 私钥、密码、token 或原始环境。
- 每次副作用写入审计事件和模型用量账本。

### FR-009 可观测性、审计与成本

- 记录源码计划、构建、Agent job、部署状态、健康/遥测验证、回滚和审批事件，事件具备关联 ID。
- 计划、制品和执行回执可按 service、machine、agent、deployment 查询；删除/轮换秘密不影响历史摘要。
- UI 明确区分“计划已生成”“已批准”“执行中”“验证成功”“未验证”和“已回滚”。
- AI 预算限制与部署资源限制分别计算，不因重试无限增加模型或 Agent 成本。

## 安全与权限

- 管理员是唯一能创建/批准 SDK 插件应用、构建 release、安装/升级 Agent、激活/回滚业务部署的角色；普通成员只可查看脱敏状态（除非后续 SDD 授权）。
- SSH 凭据一次性解密用于预检/安装，优先 Agent 之后不再使用；保存期限和手动删除入口必须显示。
- enrollment token 一次性、短期；control/data credential 分用途、可轮换；SDK Key 和 Agent local token 不混用。
- 所有用户输入（URL、unit、路径、健康检查）使用 provider 规则校验；禁止 `..`、控制字符、带凭据 URL 和任意执行参数。

## 验收场景

1. **无 Agent 的直连 SDK**：创建服务和 SDK Key，应用插桩 diff，构建/部署业务或仅运行服务；中心能接收数据，流程不要求 Agent。
2. **Agent 先于业务**：Agent enrollment/SSH 预检失败时，业务 deployment 不能进入 staging；Agent 激活后重新执行可继续。
3. **systemd 成功**：有效 unit、受控目录和制品摘要生成计划，经管理员批准后执行，active/HTTP 检查和至少一批遥测通过，状态为 succeeded。
4. **人工回滚**：管理员确认后，只有当前版本仍是该部署版本、previous version 已作为 ready release 登记，且有新鲜结构安全的 preflight 时才创建 Agent rollback job；unit 可为 active/inactive/failed，但 unit、受控目录、入口与 current 指针必须安全。Agent 以 CAS 恢复旧版本、restart 并验证健康，中心核对 `current_version` 后才标记 `rolled_back`。首次部署没有 previous release 时返回明确错误；CAS 冲突拒绝覆盖。执行结果未知或版本/健康回执不匹配会结束当前操作并保留 unknown receipt，管理员检查主机并重新预检后才可显式重试，不自动重试。
5. **遥测延迟**：服务健康但查询窗口无数据，状态显示部署成功、遥测未验证并提供重试；不能直接标记部署失败。
6. **恶意输入**：任意 shell、越界路径、错误 unit、digest 不匹配和过期 job 均在 Agent 执行前拒绝并审计。
7. **并发 revision**：用户在 AI 计划生成后修改源码，应用接口拒绝旧 revision，要求重新扫描，不能覆盖新文件。
8. **重复请求**：相同 deployment/job ID 重试不重复复制、启停或计费，中心返回之前的结构化回执。
