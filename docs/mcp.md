# MCP 接入指南

平台地址为 `https://<平台域名>/api/v1/mcp`。管理员登录后，从侧栏或右上角用户菜单进入 **MCP 接入**。首期工具只查询和创建提案；外部客户端不能批准操作、直接 SSH 或读取连接秘密。

## 个人令牌

1. 创建个人令牌，选择需要的 scope、已登记主机或明确授权全部主机，并设置期限。
2. 复制本次显示的令牌，保存到客户端受保护凭据存储或启动环境的 `LIGHTMONI_MCP_TOKEN`。关闭弹窗后平台不再显示秘密。
3. Codex 使用以下命令，命令本身不包含秘密：

```sh
codex mcp add lightmoni --url 'https://<平台域名>/api/v1/mcp' --bearer-token-env-var LIGHTMONI_MCP_TOKEN
```

Claude Code 支持 HTTP MCP 时，可在客户端配置中使用环境引用：

```json
{
  "mcpServers": {
    "lightmoni": {
      "type": "http",
      "url": "https://<平台域名>/api/v1/mcp",
      "headers": { "Authorization": "Bearer ${LIGHTMONI_MCP_TOKEN}" }
    }
  }
}
```

令牌与 SDK 上报 Key、Agent control/data、SSH 和模型凭据分开。撤销、到期或账户权限变化立即影响新调用；撤销授权也阻止其尚未开始的主机任务。当前只向管理员开放首批能力，scope 不能提升账户角色。

## OAuth

在 MCP 接入页登记客户端名称及它实际使用的回调地址，复制 Client ID。支持预注册公共客户端的 AI 客户端可通过 OAuth 授权码 + PKCE S256 发起浏览器授权。用户登录平台，在同意页检查客户端、scope、主机范围和期限后明确允许。

发现地址：`/.well-known/oauth-protected-resource/api/v1/mcp`、`/.well-known/oauth-authorization-server`。授权、token 端点由元数据提供；调用方必须指定准确 MCP resource。回调仅支持 HTTPS 或带端口的回环 IP HTTP，精确检查 path/query；原生回环仅允许端口变化。平台返回 `iss`，不支持动态客户端注册或自动抓取客户端元数据。

支持预注册 OAuth 的 Codex 版本可配置如下；Client ID 和回调来自平台登记，回调端口须与本机监听设置一致。具体选项以 [Codex 官方 MCP 文档](https://developers.openai.com/codex/mcp) 和使用的客户端版本为准：

```toml
[mcp_servers.lightmoni]
url = "https://<平台域名>/api/v1/mcp"

[mcp_servers.lightmoni.oauth]
client_id = "<平台注册的 Client ID>"
callback_url = "http://127.0.0.1:1455/callback"
callback_port = 1455
```

选择 OAuth 时不要再同时设置 PAT。OAuth 授权可以在 MCP 接入页撤销；刷新凭据轮换，旧授权码或刷新凭据被重放会撤销对应 grant。短期 access token 到期只影响新 HTTP 请求，不取消已批准长任务。真实客户端验收范围见 SDD 047，不以自动化 HTTP 测试声称所有版本开箱即用。

## 首批工具

告警模块启用时提供 47 个工具。默认任务通过任务目录读取，不另设模板目录。

| 工具 | scope | 行为 |
| --- | --- | --- |
| `lightmoni_hosts_list/get` | `hosts.read` | 已授权主机及观测到的 Agent 状态 |
| `lightmoni_hosts_inventory` / `lightmoni_hosts_details_get` | `hosts.read` | assistant-safe 详细主机目录/单主机详情，不含 Host Key 或秘密 |
| `lightmoni_tasks_list/get` | `tasks.read` | 平台默认与用户任务元数据，默认无源码/采集配置 |
| `lightmoni_tasks_get` 的 `include_source` | 还需 `tasks.source.read` | 显式读取脚本源码 |
| `lightmoni_tasks_plan` | `tasks.propose` | 自定义任务创建、任务修改、已有任务派发、执行取消和重试的审阅提案 |
| `lightmoni_proposals_get` | `tasks.read` | 提案状态；执行详情还需 `executions.read` |
| `lightmoni_executions_list/get` | `executions.read` | 原生任务执行状态，省略源码、原始输出和租约 |
| `lightmoni_telemetry_catalog` | `telemetry.catalog.read` | 表结构目录，仅全主机范围授权，无数据行/SQL |
| `lightmoni_telemetry_describe` | `telemetry.catalog.read` | 按稳定 ID 或名称读取一个目录表，仅全主机范围授权，无数据行 |
| `lightmoni_telemetry_query` | `telemetry.query` | 经既有只读 Query 执行有界查询，仅全主机范围授权；显式时间范围、最多 1000 行并有字节截断 |
| `lightmoni_alerts_list` | `alerts.read` | 告警规则目录，仅全主机范围授权，无SQL/证据/修改 |
| `lightmoni_alert_rules_list` | `alerts.read` | 规则安全字段、筛选和分页，无 SQL |
| `lightmoni_alert_rules_get` | `alerts.detail.read` | 完整规则、SQL、revision、路由和时序 |
| `lightmoni_alert_silences_list/get` | `alerts.read` | 静默目标、调度、原因和版本 |
| `lightmoni_alert_groups_list` | `alerts.read` | 责任组 ID/名称/启用状态，无联系人或供应商秘密 |
| `lightmoni_alert_proposals_get` | `alerts.detail.read` | 当前用户自己的告警提案和真实回执，不能审批 |
| `lightmoni_logs_search` | `logs.read` | 共享日志检索、冻结会话和游标；模型响应有行/字节截断 |
| `lightmoni_traces_get` | `traces.read` | 指定 Trace、1 天范围和最多 8 个目录表，返回真实 Span 及 incomplete 状态 |
| `lightmoni_services_list/get` | `deployments.read` | 服务目录，或服务真实目标与 Release；管理员安装级读取 |
| `lightmoni_deployments_list/get` | `deployments.read` | 服务部署历史或单个原生部署状态，不把计划/排队当作成功 |
| `lightmoni_deployments_events` | `deployments.read` | 部署的安全 append-only 事件时间线 |
| `lightmoni_deployments_plan` | `deployments.propose` + `deployments.read` | 为现有服务目标/Release 创建审批计划；审批与 SSH 派发前复验稳定 grant |
| `lightmoni_operations_resources_list/get` | `operations.read` | 运维资源安全配置摘要，网站/Compose 正文省略 |
| `lightmoni_operations_runs_list/get` | `operations.read` | 原生运维 Run 元数据或有界详情，敏感日志省略 |
| `lightmoni_operations_schedules_list/get` | `operations.read` | 计划任务、授权/禁用原因和真实 fire/run 状态 |
| `lightmoni_agent_releases_list` | `agents.read` | 实际 Agent Release、架构、build 和 SHA256；安装级授权 |
| `lightmoni_agent_installations_get` | `agents.read` | 按部署 ID 读取安全安装计划/回执，并复验结果主机 |
| `lightmoni_agent_updates_get` | `agents.read` | 按主机和维护 ID 读取升级/回退回执；unknown/rolled_back 不等于成功 |
| `lightmoni_dashboards_list` | `dashboards.read` | 自定义/系统大盘摘要、搜索和分页，无面板 SQL |
| `lightmoni_dashboards_get` | `dashboards.detail.read` | 完整大盘面板、变量和 SQL；安装级高敏读取 |
| `lightmoni_dashboards_versions` | `dashboards.read` | 大盘真实 revision 历史元数据 |
| `lightmoni_code_instrumentation_scan` | `code.workspace.read` | 明确配置的中心工作区只读 SDK/边界扫描，不执行项目代码 |
| `lightmoni_code_instrumentation_get` | `code.workspace.detail.read` | 既有插桩提案与安全应用回执，不返回 before 快照 |
| `lightmoni_alert_incidents_list/get` | `alerts.incidents.read` | 告警事件安全摘要，或真实事件与值班时间线 |
| `lightmoni_alert_deliveries_list` | `alerts.notifications.read` | 通知投递安全状态和关联，省略联系人、payload、供应商响应与原始错误 |
| `lightmoni_alert_response_statistics_get` | `alerts.statistics.read` | 原值班响应统计、接手率/时长和筛选；不修改记录 |
| `lightmoni_alerts_plan` | `alerts.propose` + `alerts.detail.read` | 告警规则/静默的审阅提案；包含详情但不提供 Apply/审批工具 |

主机的 `name` 是用户配置的资产名称，`observed_hostname` 仅来自当前关联且未移除的 Agent；新 Agent 尚未上报时为空，不回退旧缓存。

有限主机授权读取任务或执行列表时必须指定 `host_id`。任务元数据不包含其他主机的目标集合。服务器会再次检查直接调用的权限，工具列表不构成授权。

工具描述包含输入 Schema 和完整 structuredContent 输出 Schema。`tools/list` 默认每页 50 项；客户端应跟随 `nextCursor`，游标绑定当前授权和目录，后续页会重新鉴权。工具 annotations 仅是行为提示，不授予权限。

调用错误保留兼容的 `error.code` 分类，并增加 `error.detail_code` 表达具体原因。例如同幂等键不同内容仍返回 `code=conflict`，同时返回 `detail_code=idempotency_conflict`；限流、并发、超时和输出校验分别使用稳定的 detail_code。会话鉴权的能力 HTTP 同样返回附加 code/detail_code。

## 操作闭环

先查询真实任务和目标，再调用 `lightmoni_tasks_plan`，提供 `operation`、准确 ID、原因和稳定的 `idempotency_key`。创建/修改使用 `task.create`/`task.update` 和 task 定义；派发使用 `task.dispatch`，取消/重试使用 `run.cancel`/`run.retry`。有限主机授权只允许显式静态 host_ids，不能通过 target_all 或标签扩大，修改前后目标都会复验。

返回 `data.proposal.review_url` 后到平台审阅。审批绑定当时任务、目标和状态；有变化需要重新生成。批准派发表示进入队列，使用返回的 run ID 或 `task:<run ID>` 查询实际结果。`queued`/`running`/`unknown` 不能报告成功，取消须以远端停止回执为准。断线后使用同一业务键和内容重试；修改内容需新键。同键不同内容冲突，不自动重新派发。

普通程序可在平台登录会话内使用 `GET /api/v1/capabilities` 和 `POST /api/v1/capabilities/<工具名>/invoke`，复用同一策略。首期未另行开放服务账户 HTTP Bearer API。

## 部署条件与当前边界

设置 `LIGHTMONI_EXTERNAL_URL` 为可信 HTTPS origin（不带路径、查询、凭据），本机调试可用 loopback HTTP。未满足时仅 MCP、PAT/OAuth 和外部授权管理禁用；统一能力层、会话鉴权的能力 HTTP 与内部助手共享工具继续运行。尚未完成的 MCP 来源提案在授权适配器缺失时拒绝批准；已有外部排队项和自动重试继续绑定原稳定授权，领取前无法复验则拒绝开始。内部助手提案仍可按原人工审批流程处理。代理需保留 Authorization 与 JSON 响应，不缓存授权与工具结果。服务无协议会话，不要求粘性路由或持久 SSE。

固定官方 TypeScript SDK 1.32.2，2025-11-25 为测试基线；2026 协议尚未实现。默认每请求 128 KiB、结构深度16、工具输入16 KiB/输出64 KiB、15秒期限；每主体120请求/分钟、4并发，直接连接来源300请求/分钟。MCP拒绝批量JSON-RPC与URL查询参数。Origin若存在必须精确匹配配置origin；原生客户端可省略，仍需Bearer。

任务、告警和部署计划只创建提案，不能直接执行或自动批准。部署回滚/取消/上传、运维写工具、Agent 预检/安装/升级/卸载写工具、插桩生成/应用、code_task、服务主体或持续授权仍未开放。遥测查询只复用既有只读 Query，不开放不受约束的任意 SQL 或主机级数据隔离。原有内置 AI 其他工具继续按原权限工作。完整设计见 [平台 MCP 架构](platform-mcp.md) 和 SDD 046 及后续实施记录。
