# SDD 166 验证记录

## 真实只读 SSH

在 `moni.heyphp.com` 对 `zsw-bj-1`（machine_id `5db953cf242e8d80`）执行一次受控 `check_managed_machine_ssh(selection=auto)`，未创建提案、未更新 Agent、未修改主机。页面实际返回：

- `connected=true`、`ready=true`、`error_code=""`。
- `linux`、`supported_arch`、`curl`、`tar`、`gzip`、`sha256sum`、`systemd`、`install_privilege`、`platform_https` 全部为 true。

这证明此前 5 个红色“失败”实际为取消状态误展示，不能据此推断 SSH 工具或主机不可用。

## 真实 MCP

经用户明确授权，创建 1 小时、仅 `hosts.read + agents.read`、仅 `zsw-bj-1` 的 PAT，使用官方 `@modelcontextprotocol/sdk` Streamable HTTP 客户端连接 `https://moni.heyphp.com/api/v1/mcp`：

- 初始化成功，`server.name=lightmoni`。
- `tools/list` 仅发现 6 个只读工具：`lightmoni_hosts_list`、`lightmoni_hosts_get`、`lightmoni_hosts_inventory`、`lightmoni_hosts_details_get`、`lightmoni_agent_installations_get`、`lightmoni_agent_updates_get`。没有提案、审批或任意执行工具。
- `lightmoni_hosts_list` 仅返回授权的 1 台主机；`lightmoni_agent_updates_get` 成功读取该主机真实升级回执。
- installation-wide `lightmoni_agent_releases_list` 未暴露给单主机授权，符合边界，未误判为缺陷。
- 读取另一台未授权主机返回 `isError=true`、`detail_code=resource_not_found`。
- 经用户再次明确授权撤销 PAT 后，页面显示“已撤销”；使用同一凭据重新初始化返回 **HTTP 401**。临时令牌文件已删除，浏览器剪贴板已清理。

未执行任何 MCP 写操作或生产提案。

## 取消状态回归

- 新增后端 pending tool 测试：取消前已有工具调用但无结果，取消后 SSE 与持久事件均为 `status="cancelled"`，不再为 `error`。
- 新增前端时间线测试：运行中工具、显式取消回执及历史 `error + turn.cancelled` 均显示取消；真实 `ssh_failed + turn.failed` 保持错误。
- `node --import tsx --test --test-concurrency=1 test/assistant.test.ts test/mcp-transport.test.ts test/mcp-capabilities.test.ts`：**41/41 通过**。
- `node --import tsx --test ../web/src/features/assistant/assistant.test.mjs`：**9/9 通过**。
- `npm --prefix ai-runtime test`：**79/79 通过**。
- `npm run typecheck`、`npm run build`：通过。
- `git diff --check`、SDD Markdown 链接和代码围栏检查：通过。

## 边界

真实 SSH 与 MCP 证据来自当前线上服务；代码修复的回归证据来自隔离 Runtime/HTTP fixture。未重新构建或发布镜像，未把线上旧版本页面当作新代码验收。没有架构变化，因此未修改 `docs/system-design.md`。
