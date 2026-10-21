# SDD 021：AI 辅助 SDK 打点与业务部署

## 状态

- 状态：部分实现（计划层与只读扫描切片）、待评审
- 日期：2026-10-21
- 关联总设计：[`docs/system-design.md`](../../docs/system-design.md)
- 前置设计：SDD 012（SDK 上报路径）、SDD 014（Agent 接入）、SDD 017（SSH 引导）、SDD 020（架构双端同步）
- 架构影响：是。新增源码改写边界、业务制品与部署状态、Agent 执行任务和中心/Agent 控制路径。
- Doca 同步目标：[LightMoni 系统设计基线](https://doca.heyphp.com/#/r/2902a80f-c592-414e-9aed-64fe19f2ed53)。合并前必须按 SDD 020 读取最新版本、保留原生图块、写入后回读文本及节点连线。

### 当前切片边界（实现事实）

本 SDD 描述的是完整目标能力；当前分支只实现了其中的可审阅计划切片，不能把它描述为已经可以自动部署业务：

- `runtime/src/assistant/instrumentation.ts` 提供只读、启发式扫描器和受限的结构化插桩提案。提案目前只对可明确定位的 TypeScript/JavaScript 多行请求处理函数生成 unified diff；它不写入或应用 diff，也不执行构建或项目代码。Python、Go、Rust、Ruby 和歧义边界只返回手动步骤。
- `runtime/src/deployment` 已有 `systemd` 纯逻辑适配器和显式 provider registry，并有边界测试；它尚未连接到业务部署 HTTP 模块或 Agent executor。
- `runtime/src/server/service-deployments.ts` 目前持久化 service/target/release/deployment 元数据和脱敏 deployment events，生成 `awaiting_approval` 的通用计划，并提供管理员 `approve` 状态迁移、状态/事件查询和 `rollback_pending` 提案；尚无主机 apply、Agent job、真实 preflight、健康检查、遥测验证或最终回滚回执。
- Assistant 目前提供扫描、只读插桩提案、服务列表、部署计划提案和部署状态读取工具。构建、插桩 apply、部署执行和回滚工具仍未提供。
- `docker_compose` 目前最多作为目标元数据被登记，尚无对应适配器或执行器；只有注册到 registry 的 provider 才能执行，不能把登记成功解释为 provider 已支持。

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

**验收**：每个阶段均有审计事件和幂等 operation ID；健康失败触发可审阅的回滚；服务健康但无新遥测时显示未验证而非失败。

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
- 制品不可变，至少包含 `service_id`、`version`、`sha256`、架构、来源 revision 和创建者。
- Agent 只接收制品路径/受控下载引用和摘要，不接收源码仓库凭据或模型密钥。
- 构建失败不得创建可激活 release；同一 digest 重试必须幂等。

### FR-003 服务、目标和部署状态

- 中心持久化 `services`、`service_targets`、`releases`、`deployments`；目标必须绑定一台已登记机器和 provider 配置。
- 部署状态至少包括：`draft`、`preflight`、`awaiting_approval`、`agent_ready`、`staging`、`activating`、`verifying`、`succeeded`、`failed`、`rollback_pending`、`rolling_back`、`rolled_back`。
- 状态迁移由中心校验；Agent 回执只能推进其授权 operation，不能自行把失败写成成功。
- 每个部署保存 `requested_by`、`approved_by`、计划 revision、制品 digest、目标快照、开始/结束时间和错误码。

### FR-004 适配器和 systemd MVP

- 所有 provider 遵循 `probe → plan → apply → verify → rollback`，输入输出为 JSON 可序列化的类型，不返回 shell 字符串。
- `systemd` probe 检查 systemd 可用、unit 存在、当前 active/enabled 状态、当前版本和受控 release 目录。
- plan 仅生成受限 actions：暂存制品、daemon-reload、enable/start/restart、HTTP/TCP/systemd-active 健康检查和回滚动作。
- Agent executor 只允许目标登记的 unit、受控 release 目录和允许的健康检查；unit/路径来自服务目标配置而非模型自由输入。
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
4. **健康失败回滚**：unit 启动失败或检查超时，状态进入 rollback_pending，执行旧版本激活；Agent 保持在线，回执含固定错误码。
5. **遥测延迟**：服务健康但查询窗口无数据，状态显示部署成功、遥测未验证并提供重试；不能直接标记部署失败。
6. **恶意输入**：任意 shell、越界路径、错误 unit、digest 不匹配和过期 job 均在 Agent 执行前拒绝并审计。
7. **并发 revision**：用户在 AI 计划生成后修改源码，应用接口拒绝旧 revision，要求重新扫描，不能覆盖新文件。
8. **重复请求**：相同 deployment/job ID 重试不重复复制、启停或计费，中心返回之前的结构化回执。
