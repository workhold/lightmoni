# SDK 连接模式数据模型

状态：连接模式基线已实现；统一 fixture 和跨语言验收仍在进行 · 2026-10-18

## ConnectionConfig

| 字段 | 类型 | 必填性 | 说明 |
| --- | --- | --- | --- |
| mode | enum(agent, direct, auto) | 是 | 只控制 SDK 到 Agent/中心的 route |
| endpoint | URL | direct 必填；auto 回退必填 | 中心基础地址，规范化后请求 OTLP v1 路径 |
| data_key | secret reference | direct 必填；auto 回退必填 | 中心 data key；不等于 Agent data_credential |
| data_key_file | path | 可选 | 从 Secret 文件读取 data key |
| agent_endpoint | URL/socket | agent/auto 可选 | 默认 127.0.0.1:4318；必须是显式受控地址 |
| local_token | secret reference | 非 loopback Agent 必填 | 仅 SDK → Agent |
| local_token_file | path | 可选 | 从 Secret 文件读取 local token |
| discovery_timeout_ms | integer | 可选 | 默认 500，范围 50–2000 |
| request_timeout_ms | integer | 可选 | 默认沿用各 SDK 现有值，至少 100 |

显式值、file 值和环境值按契约优先级解析。模型不包含 enrollment_token、control_credential 或 data_credential 字段；SDK 不应出现能接收这些值的公共构造参数。

## CredentialSource

~~~text
CredentialSource =
  explicit
  | file
  | env
  | legacy-env
~~~

诊断只保留 source 名称。secret 内容不进入 model、stats、trace attributes 或 self telemetry。

## RouteSelection

~~~text
RouteSelection {
  configured_mode: agent | direct | auto
  selected_route: agent | direct | none
  phase: configured | probing | selected | blocked | uncertain
  agent_endpoint_origin?: string
  probe_result?: healthy | refused | timeout | auth_failed | tls_failed | protocol_failed
  fallback_reason?: agent_unreachable_before_body | missing_direct_credentials
  route_uncertain: boolean
  selected_at?: timestamp
}
~~~

agent_endpoint_origin 只保留 scheme、host 和 port，不保留 query、token 或完整 path。route_uncertain=true 表示 body 可能已被原路径接收，SDK 禁止自动把同一批次发送到另一条 route。

## BatchAttempt

~~~text
BatchAttempt {
  batch_id: UUID
  table: string
  route: agent | direct
  body_digest: string
  sent_body: boolean
  response: accepted | rejected | timeout | connection_error | unknown
  credential_source: explicit | file | env | legacy-env
}
~~~

同一个 batch_id 的重试必须保持 table、body_digest、created_at、trace/span 字段和 route（除非用户显式执行安全的 route refresh 且上一尝试确定没有发送 body）。unknown 不能解释为拒绝，也不能解释为可安全回退。

## InstrumentationScope

~~~text
InstrumentationScope {
  service: string
  table: string
  resource_attributes: map
  route: RouteSelection
  counters: map
}
~~~

子 table client 共享根客户端 route、queue、self telemetry 和 shutdown 生命周期。子 client 不能替换 root data key、local token 或 Agent endpoint。

## Credential ownership

~~~text
Center:
  creates data key for direct SDK
  exchanges Agent enrollment token for control/data credentials

Agent:
  stores control_credential and data_credential
  creates or receives local_token for local SDK access

SDK:
  reads data key for direct
  reads local_token for agent
  never reads or stores enrollment/control/data credentials
~~~

## Lifecycle states

~~~text
uninitialized
  -> configured
  -> probing                (auto only)
  -> selected(agent|direct)
  -> sending
  -> draining
  -> closed

configured -> blocked       (invalid config, missing credential, conflict)
sending -> uncertain        (body sent and response unknown)
uncertain -> sending        (same route retry only)
~~~

blocked 不发业务数据；closed 不允许新记录。SDK 的具体线程、Fiber、async task 或 PHP request 生命周期由各语言实现，但状态转换和 route 语义不变。
