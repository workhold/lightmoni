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

告警模块启用时提供 10 个工具。默认任务通过任务目录读取，不另设模板目录。

| 工具 | scope | 行为 |
| --- | --- | --- |
| `lightmoni_hosts_list/get` | `hosts.read` | 已授权主机及观测到的 Agent 状态 |
| `lightmoni_tasks_list/get` | `tasks.read` | 平台默认与用户任务元数据，默认无源码/采集配置 |
| `lightmoni_tasks_get` 的 `include_source` | 还需 `tasks.source.read` | 显式读取脚本源码 |
| `lightmoni_tasks_plan` | `tasks.propose` | 已有任务派发、执行取消、重试的审阅提案 |
| `lightmoni_proposals_get` | `tasks.read` | 提案状态；执行详情还需 `executions.read` |
| `lightmoni_executions_list/get` | `executions.read` | 原生任务执行状态，省略源码、原始输出和租约 |
| `lightmoni_telemetry_catalog` | `telemetry.catalog.read` | 表结构目录，仅全主机范围授权，无数据行/SQL |
| `lightmoni_alerts_list` | `alerts.read` | 告警规则目录，仅全主机范围授权，无SQL/证据/修改 |

主机的 `name` 是用户配置的资产名称，`observed_hostname` 仅来自当前关联且未移除的 Agent；新 Agent 尚未上报时为空，不回退旧缓存。

有限主机授权读取任务或执行列表时必须指定 `host_id`。任务元数据不包含其他主机的目标集合。服务器会再次检查直接调用的权限，工具列表不构成授权。

## 操作闭环

先查询真实任务和目标，再调用 `lightmoni_tasks_plan`，提供 `operation`、准确 ID、原因和稳定的 `idempotency_key`。派发使用 `task.dispatch`，取消/重试使用 `run.cancel`/`run.retry`；有限主机授权派发必须明确给出 `host_ids`。

返回 `data.proposal.review_url` 后到平台审阅。审批绑定当时任务、目标和状态；有变化需要重新生成。批准派发表示进入队列，使用返回的 run ID 或 `task:<run ID>` 查询实际结果。`queued`/`running`/`unknown` 不能报告成功，取消须以远端停止回执为准。断线后使用同一业务键和内容重试；修改内容需新键。同键不同内容冲突，不自动重新派发。

普通程序可在平台登录会话内使用 `GET /api/v1/capabilities` 和 `POST /api/v1/capabilities/<工具名>/invoke`，复用同一策略。首期未另行开放服务账户 HTTP Bearer API。

## 部署条件与当前边界

设置 `LIGHTMONI_EXTERNAL_URL` 为可信 HTTPS origin（不带路径、查询、凭据），本机调试可用 loopback HTTP。未满足时 MCP 禁用，原平台功能继续运行。尚未完成的 MCP 来源提案在授权适配器缺失时拒绝批准；已有外部排队项和自动重试继续绑定原稳定授权，领取前无法复验则拒绝开始。内部助手提案仍可按原人工审批流程处理。代理需保留 Authorization 与 JSON 响应，不缓存授权与工具结果。服务无协议会话，不要求粘性路由或持久 SSE。

固定官方 TypeScript SDK 1.32.2，2025-11-25 为测试基线；2026 协议尚未实现。默认每请求 128 KiB、结构深度16、工具输入16 KiB/输出64 KiB、15秒期限；每主体120请求/分钟、4并发，直接连接来源300请求/分钟。MCP拒绝批量JSON-RPC与URL查询参数。Origin若存在必须精确匹配配置origin；原生客户端可省略，仍需Bearer。

目前没有外部任务创建/源码修改、遥测行查询、告警修改、服务部署/运维写工具、自动批准、服务主体或持续授权。原有内置 AI 其他工具继续按原权限工作。完整设计见 [平台 MCP 架构](platform-mcp.md)，实现规格见 [SDD 047](../specs/047-platform-mcp-service/spec.md)。
