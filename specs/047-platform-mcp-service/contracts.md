# 首期契约

MCP入口 `/api/v1/mcp`；专用Bearer认证，每请求重验。`Principal={user,scopes,host_ids,credential_id,grant_id,source}`，`host_ids:null`明确全部主机、`[]`无主机授权。scope不能越过当前账户角色。

管理API `/api/v1/mcp-access` 使用平台登录；tokens、grants、clients均按当前用户隔离。PAT一次展示；中心只存hash与元数据。OAuth使用预注册公共客户端、PKCE S256、明确resource/audience，授权码和刷新令牌原子消费。

首期能力以 `lightmoni_` 前缀发现，每项严格schema。read返回安全结构化元数据，propose返回真实proposal ID及平台审阅链接；不提供apply工具。HTTP与内置助手复用同一能力对象。原始代码和输出不因任务元数据权限自动开放。

业务幂等键绑定安装实例、主体、能力与规范化输入；同键同内容返回原记录、异内容冲突。协议request ID不用于业务幂等。查询/拒绝/失败/命中均记安全调用审计，秘密和完整原始输入不进入审计。

已实现10项目录/提案工具（告警模块启用时包含alerts_list），准确工具名和scope见接入指南。平台默认任务与用户任务使用同一 list/get 目录，不提供模板工具。外部任务定义修改、遥测行查询、告警写入、自动化HTTP Bearer和2026协议未实现。统一执行索引首期仅task run投影，查询读取真实run。

管理页面 `/mcp-access`；OAuth同意 `/mcp/authorize`；OAuth access15分钟、授权码5分钟、grant/PAT默认168小时、可选1..8760小时。后台保留稳定grant供历史关联，授权码到期1天后、token到期30天后清理；仍有效的已用refresh保留用于重放检测。

MCP默认请求体128KiB、深度16、工具输入16KiB/输出64KiB、请求15秒；每用户120请求/分钟及4并发、直接连接来源300请求/分钟。URL查询参数和批量JSON-RPC拒绝。Origin存在时精确匹配固定origin；没有协议session或独立GET事件流。

集成约束：待审批的 `source=mcp` 提案若缺少 `beforeApply` 或 `afterApply` 授权 hook，应用返回 503，不修改提案、任务、执行或审计状态；内部/历史助手提案仍按原权限工作。外部执行的自动重试继承 grant 关联，并在重试创建及 Agent 领取前重验。主机投影的 `observed_hostname` 只读取当前关联且未移除的 Agent 记录，不能回退到无归属缓存。

执行 `review_url` 指向 `/machines?tab=tasks&task_view=runs&host=<host_id>`，打开该主机的实际执行记录视图；精确执行详情仍通过 `execution_id` 查询，不宣称页面支持未实现的 run 深链。
