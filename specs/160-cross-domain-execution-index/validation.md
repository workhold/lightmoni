# SDD 160 验证记录

验证日期：2026-11-14。范围为 Slice 4 跨领域执行索引与只读查询。分支 stacked 在 SDD 159 的 `aca2f73` 上，`main@acc61ef`；PR #208～#214 均 OPEN、未合入。未部署生产、未操作真实主机、未发布镜像。

## 自动化检查

| 检查 | 结果 | 覆盖 |
| --- | --- | --- |
| 全领域能力、执行索引写入/刷新、官方 MCP 与权限定向测试 | 165/165 通过 | `/tmp/lightmoni-domain-execution-index-targeted-final.log` |
| 最终 `npm --prefix runtime test` | 1869 项：1829 通过、35 跳过、5 失败 | `/tmp/lightmoni-domain-execution-index-runtime-final.log`；失败集合与既有基线一致 |
| 最终 `npm run typecheck` | 通过 | `/tmp/lightmoni-domain-execution-index-typecheck-final.log`；runtime、ai-runtime、web |
| 最终 `npm run build` | 通过 | `/tmp/lightmoni-domain-execution-index-build-final.log`；仅有既有 Web 依赖警告 |
| Markdown 链接/代码围栏、`git diff --check`、秘密模式扫描 | 通过 | 无失效本地链接、空白错误或秘密模式 |

最终全量失败仅为 `agent-host-admission`、`machine-service-addresses`、`machine-terminal`、`managed-machines` 和 `node-lifecycle` 的既有用例，不宣称 runtime 全量通过。

## 行为证据

- Task Run、服务 Deployment、运维 Run、Agent 首装和 Agent 维护均可按 domain:native_id 查询，读取时从原生记录刷新真实 native_state 和安全 review_url。
- 部署、运维和 Agent 首装创建时写入 execution_index，Task Run 沿用原索引；索引只含 domain/native_id/host_id/state，不包含第二份执行回执。
- `lightmoni_domain_executions_list/get` 支持 domain/state 过滤和有界分页，executions.read、领域 Scope 和 Host 授权生效；错误 Host 和缺 Scope 均不可见。
- 官方 MCP 客户端读取真实 Task Run，native_state=queued、host_id=one；服务部署/运维/Agent 首装保持 awaiting_approval，Agent 维护 rolled_back 不映射为成功。
- 内部助手、MCP 和会话 HTTP 复用同一索引，原任务专用执行查询保持兼容。
- 工具总数由 51 增至 53；OpenAPI/Bearer、服务主体和持续授权未开放。

## 未验证与剩余范围

官方 MCP SDK 自动化不等于真实 Codex/Claude OAuth 或生产环境验收；本轮未执行这些验证。历史未索引记录不保证全部回填，OpenAPI/Bearer、Agent 后续生命周期、服务回滚/核验和真实客户端矩阵仍需独立处理。

交付状态：实现与验证完成，等待 PR 评审；未获本轮合并授权，不自动合并。
