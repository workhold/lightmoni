# SDK 连接与凭据契约

状态：连接模式与凭据读取基线已实现；跨语言验收仍在进行 · 2026-10-18
对应规格：[spec.md](spec.md)

本文冻结 SDK 配置、环境注入、凭据边界和路由选择。SDK 不负责 enrollment 或节点凭据签发；这些由 010 规格的中心/Agent 基线处理。

## 1. 配置对象

当前发布的 TypeScript/JavaScript、Python、Ruby 提供等价字段；字段名按语言习惯使用 snake_case 或 camelCase，但序列化配置与错误代码保持一致。

~~~text
SdkConnectionConfig {
  mode: "agent" | "direct" | "auto"
  endpoint?: URL                 // LightMoni center，direct/auto 回退需要
  data_key?: Secret              // 直连 data key，table-scoped
  data_key_file?: Path           // 直连 data key 文件
  agent_endpoint?: URL           // 默认 http://127.0.0.1:4318
  local_token?: Secret            // SDK → Agent；不发送到中心
  local_token_file?: Path
  discovery_timeout_ms?: 500     // 只用于本机 Agent 健康探测
  request_timeout_ms?: 5000      // 单次业务请求既有 SDK 上限
}
~~~

service、table、资源属性、批次容量和重试配置仍沿用现有 SDK 契约，不因 mode 改变。endpoint 允许中心基础地址、服务根地址或现有 SDK 接受的路径；SDK 规范化后追加 /v1/metrics、/v1/logs、/v1/traces，不会把 endpoint 发给任何第三方发现服务。Agent endpoint 只接受明确的 HTTP(S) 地址或实现已声明的本机 Unix socket，不由用户输入推断中心地址。

## 2. 凭据分类

| 名称 | 使用方 | 签发/来源 | 可访问内容 | SDK 是否可见 |
| --- | --- | --- | --- | --- |
| enrollment token | Agent 首次安装 | 管理员在中心创建，短期、一次性 | 仅兑换节点凭据 | 否，SDK 禁止读取 |
| control_credential | Agent 控制客户端 | 中心兑换签发，绑定 agent_id | 心跳、配置拉取、轮换、节点状态 | 否 |
| data_credential | Agent 上报客户端 | 中心兑换签发，绑定 agent_id 和数据 audience | Agent → 中心指标、日志、链路 | 否 |
| data key | 直连 SDK | 管理员/Secret Manager 创建，按 table 限制 | SDK → 中心指标、日志、链路 | 是，仅在进程内使用 |
| local_token | SDK → 本机 Agent | Agent 安装配置生成或管理员注入 | 本机 OTLP、状态/配置代理 | 是，仅发给 Agent |
| agent_id / host_id | Agent 和服务端 | Agent 首次运行生成并持久化 | 节点身份、数据归因 | 不构成认证 |

agent_id、host_id、service、table 和 trace ID 都不是凭据。任何请求都不能以请求正文中的 agent_id 替代控制/数据凭据绑定验证。

## 3. 环境注入

### 3.1 规范变量

| 变量 | 类型 | 适用模式 | 语义 |
| --- | --- | --- | --- |
| LIGHTMONI_MODE | agent / direct / auto | 全部 | 连接模式；缺失时使用 SDK 发行说明中明确的默认值，不能按网络状态猜测 |
| LIGHTMONI_ENDPOINT | URL | direct、auto 回退 | 中心基础地址；只访问用户配置的 origin |
| LIGHTMONI_DATA_KEY | secret | direct、auto 回退 | 直连 table-scoped data key；兼容部署可由 LIGHTMONI_KEY 提供 |
| LIGHTMONI_DATA_KEY_FILE | 文件路径 | direct、auto 回退 | 读取单行 data key；推荐 Secret 文件 |
| LIGHTMONI_AGENT_ENDPOINT | URL/Unix socket | agent、auto | 本机 Agent 接收地址；缺失默认为 http://127.0.0.1:4318 |
| LIGHTMONI_LOCAL_TOKEN | secret | agent、auto | Agent 本地认证 token |
| LIGHTMONI_LOCAL_TOKEN_FILE | 文件路径 | agent、auto | 读取单行 local token；非 loopback 或跨容器时必须提供 |

LIGHTMONI_KEY 是兼容别名，只能作为 LIGHTMONI_DATA_KEY 的退役过渡，并在诊断中提示改名；它不是 control credential、data credential 或 enrollment token。SDK 不读取 LIGHTMONI_ENROLLMENT_TOKEN、LIGHTMONI_CONTROL_CREDENTIAL 或 LIGHTMONI_AGENT_DATA_CREDENTIAL。

### 3.2 来源优先级和冲突

每个字段按以下顺序解析：

1. 程序显式配置（例如 dataKey / data_key）；
2. 对应 *_FILE 文件；
3. 对应环境变量。

同一个 secret 同时存在不同来源且内容不一致时，初始化失败并返回 credential_source_conflict；不能以“最后读取的值”为准。显式空字符串表示未配置，不得把空值当作清除已保存的环境 secret。endpoint 与 mode 的冲突也返回配置错误。

secret 文件必须是常规文件，默认建议权限 0600，UTF-8，最多 16 KiB，读取后去掉一个末尾 LF/CRLF；目录、FIFO、过长值和不可读文件均拒绝。实现可以放宽权限检查以适配容器 Secret，但必须在诊断中给出警告。环境变量是兼容注入方式，生产部署优先使用 Secret 文件或 Secret Manager；SDK 不把环境变量写回磁盘。

程序显式配置适合测试和 Secret Manager 适配，不代表可以把明文写进源代码、镜像层、命令行或版本库。官方示例统一展示 from_env/fromEnv 或显式读取受限文件。

## 4. 路由选择和发现

### 4.1 agent

~~~text
agent_endpoint → Agent /healthz 或 /status（带 local_token）
               → Agent /v1/{metrics,logs,traces}
               → Agent 使用自己的 data_credential 上报中心
~~~

- 不读取 endpoint 或 data_key，即使它们存在也不改投中心。
- local_token 只发送到已配置的 Agent origin；不得被拼到 URL、trace、中心请求或异常文本。
- Agent 未开启 token 时，loopback 可按 Agent 契约省略；跨用户、非 loopback、跨容器必须配置 token 和网络 ACL。
- Agent 返回 401/403、协议错误、TLS 错误或持久化背压时，SDK 暴露对应错误并保留批次，不能切换 direct。

### 4.2 direct

~~~text
center endpoint + data_key → Authorization: Bearer <data_key>
                            → center /v1/{metrics,logs,traces}
~~~

- 初始化必须同时有 endpoint 与 data key；data key 的 allowed_tables 在中心验证。
- SDK 不访问 /api/v1/agents/*、管理员 API、enrollment API 或模型/配置管理 API。
- 401/403 不是发现失败；停留在直连并报告凭据错误，不重试到 Agent。

### 4.3 auto

自动模式是“受限本机探测 + 一次启动路由选择”，不是全网服务发现：

1. 解析显式 agent_endpoint/LIGHTMONI_AGENT_ENDPOINT；未提供时仅尝试默认 loopback http://127.0.0.1:4318。
2. 以最多 discovery_timeout_ms 请求 /healthz；需要 local token 时再请求带鉴权的 /status。
3. 成功即选择 Agent，并锁定本次进程路由；存在 endpoint 但鉴权、TLS、协议或 HTTP 错误时失败关闭。
4. 只有在未建立连接且未发送任何业务 body 的探测失败，且 endpoint 与 data key 都存在时，才选择 direct。
5. 无 Agent、无 direct 凭据或冲突配置时，返回 auto_route_unavailable。

自动模式不得执行端口范围扫描、DNS SRV/mDNS、云元数据探测、任意远程主机探测、中心反向回连或 enrollment token 兑换。进程运行中已向 Agent 发送过业务 body 后，Agent 暂时不可达不触发静默直连，以避免 Agent 已持久化但响应丢失时重复发送；用户可显式重启或调用路由刷新 API，由实现提供批次不确定状态。

### 4.4 路由状态和诊断

stats 至少提供：configured_mode、selected_route、agent_probe、fallback_count、last_route_error、credential_source（仅 explicit/file/env/legacy-env）和 route_uncertain。禁止返回 secret、Authorization、完整 URL 查询参数、请求正文或上游响应原文。

## 5. HTTP、批次和失败语义

- Agent 和中心均使用现有 OTLP/HTTP /v1/metrics、/v1/logs、/v1/traces；保留 X-Lightmoni-Table、X-Lightmoni-Batch-ID、X-Lightmoni-Batch-Created-At 和标准 OTLP 编码。
- route 选择不改变 batch ID、payload、table、service 或 trace context。重试使用同一批次身份；凭据轮换也不重写冻结正文。
- 连接失败、超时、429/502/503/504 依现有有限退避；401/403、table 越权和永久协议错误进入可见拒绝/隔离，不无限重试。
- 未知请求结果（body 可能已被接收）不得在同一批次上静默改投另一条路径；需要等待原路径恢复或生成显式 route_uncertain 诊断。
- 自定义打点调用只改内存/有界聚合器，不在业务记录路径同步探测网络。flush/shutdown 的语言差异记录在各 SDK README，但不改变上述交付边界。

## 6. 自定义打点契约

每个当前发布语言的原生 SDK 都必须提供以下语义（名称按语言惯例）：

| 信号 | 最低能力 | 约束 |
| --- | --- | --- |
| Counter | 非负 Int64/等价精度、Delta 聚合 | 负数、非整数和超限值拒绝或计入 invalid |
| Gauge | 最后观测值 | 不因窗口无数据补零 |
| Histogram | 显式边界、count/sum/buckets | 边界、单位和类型固定后不能在同一 table 冲突 |
| Log | severity、正文、结构化属性、可选 trace/span | 属性类型和大小受限；日志筛选不改变指标/链路 |
| Span/Trace | 根/子 span、状态、属性、W3C traceparent/tracestate | 记录时捕获上下文，重试保持原值 |
| Table scope | withTable / with_table 等子客户端 | 子客户端共享根生命周期和连接路由 |

中心按 table 授权；自定义属性不能替代 service、instance、agent 或 trace 身份。浏览器只可使用同源/受限 relay 或明确的短期 token，不能把长期中心 data key 编译进前端 bundle。

## 7. 支持矩阵

| 原生 SDK | 运行环境 | 三种模式 | 环境构造 | 自定义打点 | 发布状态 |
| --- | --- | --- | --- | --- | --- |
| Go | Go 1.26+ | 源码基线 | NewFromEnv + 显式 Config | 源码保留 | 后续支持；不生成本次发布包，未纳本次发布验收 |
| TypeScript/JavaScript（Node） | Node 20+ | agent/direct/auto | createLightMoniFromEnv（基线已实现）+ options | metrics、logs、traces、W3C、table | 保留 |
| TypeScript（浏览器） | 现代浏览器 | agent；direct 仅受限 relay/短期 token；auto 仅探测显式同源 Agent | createLightMoniFromEnv 由构建/宿主注入，不能读取中心长期 key | metrics、logs、traces、W3C、table | 保留，浏览器安全限制 |
| Python | 3.9+，标准库 | agent/direct/auto | from_env（基线已实现）+ Client | metrics、logs、traces、W3C、table | 保留 |
| PHP | — | — | — | 用标准 OTLP exporter 迁移 | 原生 SDK 下线 |
| Ruby | 2.7+ | agent/direct/auto | LightMoni.from_env（基线已实现）+ options | metrics、logs、traces、W3C、table | 保留 |
| Rust | 1.85+ | 源码基线 | Client::from_env + Config | 源码保留 | 后续支持；不生成本次发布包，未纳本次发布验收 |
| Java/Kotlin | JDK 17+ | 不再扩展 | — | 用标准 OTLP exporter 迁移 | 原生 SDK 移除 |
| C#/.NET | .NET 8+ | 不再扩展 | — | 用标准 OTLP exporter 迁移 | 原生 SDK 移除 |

“支持”表示 LightMoni 原生包、文档、构建和语义验收；不限制用户使用外部 OpenTelemetry exporter 向兼容 OTLP endpoint 上报。当前发布与接入页安装选项仅有 TypeScript/JavaScript、Python、Ruby；Go/Rust 源码基线不构成发布或验收承诺。Java/C#/PHP 的历史证据保留，标准 OTLP 接收与历史数据不受下线影响。

## 8. 兼容与迁移

LIGHTMONI_KEY、现有显式 endpoint/key 构造和 Agent 旧配置可在过渡期继续读取，但只能映射到 data key/直连或 local token 的明确位置；不能将一个旧 key 继续当作 control/data 两种权限的长期设计。新文档、生成器和测试使用 LIGHTMONI_DATA_KEY 及 *_FILE。

Java/C#/PHP 使用方迁移到标准 OpenTelemetry OTLP exporter 或自有 HTTP/OTLP 客户端，设置 table 头和 data key 的方式遵循中心契约。移除原生目录不删除已上报数据，不修改中心查询与接收接口。
