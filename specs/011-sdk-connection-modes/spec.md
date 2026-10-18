# Feature Specification: SDK 连接模式与凭据边界

**Feature Branch**: `011-sdk-connection-modes`
**Created**: 2026-10-18
**Status**: Connection-mode baseline implemented; cross-language verification remains
**Input**: SDK 同时支持独立 LightMoni Agent 和中心直连；业务可以自定义指标、日志和链路；Java 与 C# 不再作为 LightMoni 原生 SDK 发布语言。

## User intent and scope

业务服务应能用同一套 SDK 记录自定义 Counter、Gauge、Histogram、日志、Span/Trace、属性和逻辑 table。部署了本机 Agent 的服务默认把数据交给 Agent，由 Agent 负责持久队列、主机身份和断网补传；无法安装 Agent 的服务仍可用受 table 限制的 data key 直连中心。SDK 只使用已经发放的凭据，不负责管理员操作、任意远程发现或签发密钥。

本规格冻结三种连接模式、凭据来源、环境注入、发现和失败回退边界，以及原生 SDK 的支持矩阵。Agent 的 enrollment、control/data credential 签发与节点生命周期由 [010-agent-deployment](../010-agent-deployment/spec.md) 负责；本规格只定义 SDK 如何使用它们，不重复定义节点注册流程。

## Current baseline and intended change

| 方面 | 当前状态 | 本规格冻结的目标 |
| --- | --- | --- |
| 上报路径 | SDK 可直连中心，也可向本机 Agent 发 OTLP；各语言配置入口不完全一致 | 六种保留语言已提供 `agent` / `direct` / `auto` 基线；默认仍由部署模板选择，不隐式猜测远程中心 |
| 密钥读取 | 示例通常读取 `LIGHTMONI_ENDPOINT`、`LIGHTMONI_KEY` 再显式传入 | 六种 SDK 已提供 `from_env` / `fromEnv` 等价入口；支持 Secret 文件，保留 `LIGHTMONI_KEY` 兼容别名并提示迁移 |
| Agent 凭据 | 旧 `config.key` 可能同时承担控制和数据权限 | Agent enrollment 基线已分开保存 control/data credential；SDK 只看到本地 `local_token` |
| 自定义打点 | 各语言已有指标、日志、链路和属性 API，生命周期略有差异 | 六种保留语言都提供同等信号语义、table 作用域、有限缓冲和诊断；协议字段保持兼容 |
| 语言发布 | Java 与 .NET/C# 原生 SDK 从当前工作树和发布矩阵移除 | Java、C# 已从 LightMoni 原生 SDK 发布、示例、构建和支持矩阵中移除；中心仍接受标准 OTLP exporter |

## User scenarios and acceptance

### US1 使用本机 Agent 上报（P1）

运维已在主机独立安装 LightMoni Agent。业务只配置 Agent endpoint 和可选的 local token；业务进程不需要知道中心地址或 Agent 的 control/data credential。Agent 不随业务进程重启而丢失队列。

**Acceptance**

- `mode=agent` 只向显式 Agent endpoint 发送，Agent 不可达、local token 无效或返回 4xx 时明确报错并保留有限内存批次，不改投中心。
- SDK 请求不包含 enrollment token、control credential 或 data credential；local token 只发给配置的本机/受限 Agent endpoint。
- Agent 返回成功前 SDK 不丢弃批次；Agent 的持久 ACK、补传和节点身份由 Agent 契约负责。

### US2 无 Agent 直连中心（P1）

Serverless、短生命周期容器或无法安装 Agent 的服务使用中心地址和 table-scoped data key 直连。业务可从环境变量、受限 Secret 文件或 Secret Manager 注入 key，代码仓库和镜像中不包含明文。

**Acceptance**

- `mode=direct` 要求合法中心 endpoint 与 data key；请求使用 `Authorization: Bearer <data key>` 和现有 table/batch 头。
- data key 只允许其 `allowed_tables`，不可被 SDK 声明的 service、agent_id 或请求正文扩大权限。
- 缺 key、格式错误、401/403、TLS 错误和不可达均在诊断中可见；SDK 不调用管理员 API 申请新 key。

### US3 自动选择本机 Agent 或直连（P1）

部署模板使用 `mode=auto`。SDK 先尝试固定范围内的本机 Agent；只有探测失败且同时配置了中心 endpoint 与 data key 时，才在发送首个业务批次前选择直连。用户可以查看最终选择的 route 和原因。

**Acceptance**

- 自动发现只尝试显式 `agent_endpoint`、其受控服务名和默认 `http://127.0.0.1:4318`；不扫描端口、解析任意主机、不访问 mDNS/云元数据或远程控制 API。
- Agent 已返回鉴权错误、TLS/证书错误、协议错误或已经接受过业务请求时，`auto` 不静默绕过 Agent；只有“未建立连接且未发送业务 body”的探测失败可在启动选择阶段回退直连。
- 没有可用 Agent 且没有直连 data key 时，`auto` 失败关闭并提示配置缺失；不把 enrollment token、control credential 或任意环境变量当作 data key。
- 自动选择结果、探测耗时、回退原因和最终 endpoint 进入脱敏诊断；密钥、完整 Authorization 和请求正文不进入日志。

### US4 安全注入与轮换（P1）

管理员在中心创建 data key；运维通过 Kubernetes Secret、Docker Secret、Vault/云 Secret Manager 或受限文件注入。凭据轮换时，应用重启或调用显式 update API 使用新值；SDK 不自行签发、复制或上传密钥。

**Acceptance**

- 程序参数可以显式传入配置，但官方示例和生成模板必须从 secret store、`*_FILE` 或环境变量读取，禁止把明文写入源代码、镜像和命令行。
- 同一字段同时存在程序参数、secret 文件和环境变量时按固定优先级处理；冲突值默认拒绝启动，不猜测来源。
- SDK 仅在初始化、显式 refresh/update 或重启时读取 secret；旧批次重试继续使用其首次认证归因，不把新 key 改写为新批次身份。
- 环境、文件、异常、状态页和诊断都对 key/token 脱敏；local token 不发送到中心。

### US5 六种语言保持自定义打点（P1）

Go、TypeScript/JavaScript、Python、PHP、Ruby、Rust 的用户可以用语言习惯的 API 自定义指标、日志、Span/Trace、属性和 table，并选择三种连接模式。中心只依赖统一 OTLP 与批次契约，不依赖 SDK 语言。

**Acceptance**

- 每种保留语言至少有 Counter、Gauge、Histogram、结构化日志、Span/Trace、W3C trace context、table 作用域和显式 flush/shutdown（受语言生命周期限制）示例。
- 自定义属性必须经过类型、数量、大小和基数限制；超过限制有可查询的 dropped/overflow 计数，不阻塞业务记录线程。
- Java 与 C# 不再出现在 LightMoni 原生 SDK 的安装、文档、示例、CI 或发布清单中；现有应用可改用标准 OpenTelemetry OTLP exporter 或 HTTP 兼容入口。
- 删除原生 Java/C# 包不删除中心已有数据，不改变 OTLP 接收协议，也不撤销此前已经发放的 data key。

## Functional requirements

- **FR-001**: `mode` 只接受 `agent`、`direct`、`auto`；缺省值由 SDK/部署模板明确记录，不能因网络失败临时改变为另一模式。
- **FR-002**: `agent` 模式只使用 `agent_endpoint`；`direct` 模式只使用中心 `endpoint`；`auto` 只按 US3 的本机发现和启动选择规则执行。
- **FR-003**: SDK 不实现 enrollment、管理员登录、key 创建、control credential 兑换或任意远程主机发现；这些属于中心/Agent 控制面。
- **FR-004**: Agent 使用中心签发的 `control_credential` 管理心跳/配置/轮换，使用独立 `data_credential` 上报；SDK 只使用 local token 访问 Agent。
- **FR-005**: 直连 SDK 使用按 table 限制的 data key；所有 signal 共用认证边界，但不允许 SDK 通过 payload 声明扩大 table 或 agent 权限。
- **FR-006**: 规范环境变量包括 `LIGHTMONI_MODE`、`LIGHTMONI_ENDPOINT`、`LIGHTMONI_DATA_KEY`、`LIGHTMONI_DATA_KEY_FILE`、`LIGHTMONI_AGENT_ENDPOINT`、`LIGHTMONI_LOCAL_TOKEN`、`LIGHTMONI_LOCAL_TOKEN_FILE`；旧 `LIGHTMONI_KEY` 仅作为兼容别名。
- **FR-007**: secret 文件读取 UTF-8 单值、去除一个末尾换行、权限建议 0600；空值、超长值、目录、符号链接策略和冲突来源在契约中固定，错误不得静默忽略。
- **FR-008**: 程序参数、secret 文件和环境变量的优先级跨语言一致；secret 内容和 Authorization 永不写入日志、诊断、trace attributes、URL、命令行或 batch payload。
- **FR-009**: 自定义 metric/log/trace API 复用现有 table、属性、批次 ID、重试、容量和 W3C trace 约定；SDK 业务记录路径不得同步触网。
- **FR-010**: `auto` 选择结果、探测错误、最终 route、fallback 计数和 credential source（仅 source 名，不含内容）可通过 stats 查询。
- **FR-011**: 各 SDK 提供等价的环境构造函数和显式配置 API；API 命名按语言惯例映射，但字段、默认值、错误类别和生命周期语义一致。
- **FR-012**: 官方支持矩阵只保留 Go、TypeScript/JavaScript（Node/浏览器有安全限制）、Python、PHP、Ruby、Rust；Java/C# 迁移和移除任务必须先于发布清单更新完成。
- **FR-013**: 浏览器代码不得持有中心长期 data key；浏览器直连仅允许业务后端/受限 relay 提供的短期、table-scoped token，或使用同源/显式 Agent 入口，具体安全边界在契约中说明。
- **FR-014**: 凭据轮换不修改冻结批次正文和批次 ID；在结果不确定时不得把同一批次静默发送到第二条路径造成重复，必要时报告 `route_uncertain` 并等待人工/下一次重试。

## Non-goals

- 不让 SDK 自动向中心申请密钥、自动创建节点或使用 enrollment token。
- 不做任意远程 Agent 扫描、mDNS/云元数据发现、中心反向连接或端口探测。
- 不在本规格实现 Agent 的 systemd、enrollment API、control/data credential 签发或远程执行能力。
- 不提供 Java/C# 原生 SDK 的新功能、兼容层或继续发布；标准 OTLP 接入不属于原生 SDK 支持承诺。
- 不为自定义打点提供无界队列、无限重试、动态任意脚本执行或自动修改业务代码。

## Success criteria

- **SC-001**: 六种保留语言各有真实测试覆盖 `agent`、`direct` 和适用的 `auto` 初始化；路由、错误和凭据来源在诊断中可解释。
- **SC-002**: 生产示例与部署模板不含明文 key/token；secret 文件和环境变量在进程、容器、systemd 和 Kubernetes 场景均有最小权限说明。
- **SC-003**: 自动模式不会把 key/token 发送到未知地址；Agent 鉴权或协议错误不会静默回退直连；探测失败回退只发生在首个业务批次发送前。
- **SC-004**: 自定义指标、日志和链路在 Agent 与直连两条路径的中心数据语义一致，table 权限、批次重试、trace 关联和容量边界不变。
- **SC-005**: Java/C# 从原生支持矩阵、包发布、CI 和文档导航移除；标准 OTLP exporter 迁移说明可用，既有中心数据和协议继续工作。

## Related specifications

- [Agent 独立部署与凭据](../010-agent-deployment/spec.md)
- [Agent 契约](../010-agent-deployment/contracts.md)
- [Python SDK 远程配置](../004-python-sdk-reporting/spec.md)
- [SDK 现有协议说明](../../sdk/README.md)
