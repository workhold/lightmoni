# 目标契约（未实现）

## 三种适配器

`MCP / Web HTTP / 内置助手 → CapabilityDispatcher.invoke(Principal, capability_id, input, InvocationContext)`。

Principal 的 user_id、role、scopes、resource_grants 来自服务端认证，不接受调用参数授予。`source` 由入口设置；客户端提供的名称/版本/会话仅为不可信的关联信息。输入 schema 禁止额外字段。

## 描述符

`CapabilityDescriptor = {id,version,input_schema,output_schema,required_scopes,target_resolver,effect,execution_strategy,approval_policy,idempotency_policy,result_projection,audit_policy,limits}`。

effect 为 read/propose/execute；execution_strategy 为 center_read/center_change/agent_config/agent_task/agent_job/ssh_lifecycle。首期对外仅 read/propose。自定义脚本有额外的代码读取/编写授权，不能通过普通 metadata.read 获得源码。

## MCP

计划地址 `https://<平台域名>/api/v1/mcp`，`tools/list`、`tools/call` 使用标准 MCP。2025-11-25 兼容适配器使用 initialize/initialized；2026-07-28 适配器使用 server/discover 与每请求 _meta，不使用已移除的初始化握手或会话头。两者独立验收，当前均未实现；首个候选兼容矩阵为 2025-11-25，必须实测本地 Codex/Claude 后才能承诺支持。资源接口按实际支持声明；首期不声明 sampling、roots、elicitation 或协议任务扩展。业务 execution_id 不等于 MCP request/session/task ID。

工具成功结果用 `structuredContent` 及兼容文本内容，均从相同已授权安全投影生成，不能一处脱敏另一处暴露。业务错误 `isError:true` 并给稳定 code；鉴权失败在协议处理前按 401/403 返回，非法方法/参数按 JSON-RPC 规范处理。

业务响应：`{schema_version:1,invocation_id,kind:"read"|"proposal"|"execution",status,data?,proposal_id?,execution_id?,review_url?,native_status?,retryable?,truncated?,next_cursor?}`。外部 review_url 只能由已配置的平台 HTTPS origin 和固定路由生成。

## 身份与权限

OAuth access token 绑定 MCP canonical resource URI，授权码 PKCE S256 单次消费；刷新令牌轮换/重放检测。PAT 为 `lm_pat_` 前缀高熵随机值，中心仅存 hash、主体、scope、资源授权、有效期、撤销和使用摘要。SDK/Agent token、登录 cookie、SSH 和模型凭据不作为 MCP Bearer。

建议 scope：`hosts.read`、`hosts.check.propose`、`telemetry.catalog.read`、`telemetry.query`、`alerts.read`、`alerts.propose`、`tasks.read`、`tasks.source.read`、`tasks.propose`、`deployments.read`、`deployments.propose`、`operations.read`、`operations.propose`、`agents.read`、`agents.maintain.propose`、`executions.read`。没有通配 admin scope；scope 不授予账户原本没有的权限。

## 幂等、执行与取消

有副作用的提案创建、提交和重试必须带 `idempotency_key`。唯一域为 installation_id + principal_id + capability_id + key；installation_id 是平台安装实例，不是业务 deployment_id。内容 hash 包含规范化输入、目标快照和版本。同键同内容返回原授权可见记录，同键不同内容返回 idempotency_conflict；令牌轮换不改变 principal_id。幂等保留期不少于最长执行及重试窗口，默认 30 天；未知或未结束记录的键不提前淘汰。

审批绑定发起主体、稳定 grant_id/授权修订、能力/源码版本、目标集合及修订、参数摘要、影响、审批人/授权记录和期限。工具层确认或 MCP elicitation 不能创建 approval。OAuth access token 自然过期仅影响新请求，不使已批准长任务失效；grant/PAT 撤销或过期、账户停用/降权或持续授权失效时，取消尚未开始项。已开始项按既有协议结束并保留结果。

执行索引状态保留 awaiting_approval/queued/running/succeeded/failed/cancelled/rolled_back/unknown，以及原生 status/phase。仅关联既有领域记录；不能将 rolled_back 映射为 succeeded，也不能将 queued 当作已执行。取消 queued 可立即确认，running 需远端停止证明；取消 RPC/关闭 MCP 会话不等于业务取消。

审计至少包含 invocation_id、trace_id、principal/owner、credential_id、可信入口、声明的 client 信息、capability/version、目标和参数摘要、决策、proposal/execution/native_ref、幂等摘要、时间及安全错误。拒绝、schema 失败、取消、幂等命中也记录摘要，认证失败记网关安全事件。持久接受与领域提交/审计事件关联，无法持久记录时不派发。秘密不入日志或模型，原始主机输出默认不进入 MCP；秘密引用还需主体/用途/目标及固定能力的 use 权限。
