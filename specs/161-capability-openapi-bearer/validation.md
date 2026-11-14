# SDD 161 验证记录

验证日期：2026-11-14。范围为 Slice 4 OpenAPI 与普通程序 Bearer 调用。分支 stacked 在 SDD 160 的 `a7ceb44` 上，`main@acc61ef`；PR #208～#215 均 OPEN、未合入。未部署生产、未操作真实主机、未发布镜像。

## 自动化检查

| 检查 | 结果 | 覆盖 |
| --- | --- | --- |
| 全领域能力、OpenAPI/Bearer、MCP 与权限定向测试 | 167/167 通过 | `/tmp/lightmoni-openapi-bearer-targeted-final.log` |
| 最终 `npm --prefix runtime test` | 1871 项：1831 通过、35 跳过、5 失败 | `/tmp/lightmoni-openapi-bearer-runtime-final.log`；失败集合与既有基线一致 |
| 最终 `npm run typecheck` | 通过 | `/tmp/lightmoni-openapi-bearer-typecheck-final.log`；runtime、ai-runtime、web |
| 最终 `npm run build` | 通过 | `/tmp/lightmoni-openapi-bearer-build-final.log`；仅有既有 Web 依赖警告 |
| Markdown 链接/代码围栏、`git diff --check`、秘密模式扫描 | 通过 | 无失效本地链接、空白错误或秘密模式 |

最终全量失败仅为 `agent-host-admission`、`machine-service-addresses`、`machine-terminal`、`managed-machines` 和 `node-lifecycle` 的既有用例，不宣称 runtime 全量通过。

## 行为证据

- 真实 PAT Bearer 可发现并调用 `lightmoni_hosts_list`，返回真实 Host，调用审计 source=mcp；无效 Bearer 返回 401。
- Web 会话无需外部 MCP 配置即可发现/调用同一能力，审计 source=web，保持原兼容。
- `GET /api/v1/openapi.json` 返回 OpenAPI 3.1，包含当前主体可见的实际 invoke 路径、输入/输出 Schema、required_scopes 和 bearer/cookie 安全定义；不包含 PAT、秘密或目标数据。
- OpenAPI 与 Scope 过滤一致：hosts.read 可见主机能力，tasks 能力不暴露；服务器 URL 来自 externalURL。
- app 注入可选 McpAccess，Bearer 复用原角色、Scope、Host、grant、限流和审计，不模拟 MCP，不开放服务主体或持续授权。
- 工具总数保持 53；新增文档端点不改变现有 MCP 工具清单。

## 未验证与剩余范围

真实 Codex/Claude OAuth、普通生产程序兼容矩阵和生产环境未执行。服务主体、持续授权、Agent 后续生命周期、服务回滚/核验和其他领域提案仍需独立处理。

交付状态：实现与验证完成，等待 PR 评审；未获本轮合并授权，不自动合并。
