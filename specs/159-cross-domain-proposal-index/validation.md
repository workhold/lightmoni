# SDD 159 验证记录

验证日期：2026-11-14。范围为 Slice 4 跨领域提案索引与只读查询。分支 stacked 在 SDD 158 的 `4d07d0a` 上，`main@acc61ef`；PR #208～#213 均 OPEN、未合入。未部署生产、未操作真实主机、未发布镜像。

## 自动化检查

| 检查 | 结果 | 覆盖 |
| --- | --- | --- |
| 全领域能力、索引写入/刷新、官方 MCP 与权限定向测试 | 164/164 通过 | `/tmp/lightmoni-domain-proposal-index-targeted-final.log` |
| 最终 `npm --prefix runtime test` | 1868 项：1828 通过、35 跳过、5 失败 | `/tmp/lightmoni-domain-proposal-index-runtime-final.log`；失败集合与既有基线一致 |
| 最终 `npm run typecheck` | 通过 | `/tmp/lightmoni-domain-proposal-index-typecheck-final.log`；runtime、ai-runtime、web |
| 最终 `npm run build` | 通过 | `/tmp/lightmoni-domain-proposal-index-build-final.log`；仅有既有 Web 依赖警告 |
| Markdown 链接/代码围栏、`git diff --check`、秘密模式扫描 | 通过 | 无失效本地链接、空白错误或秘密模式 |

最终全量失败仅为 `agent-host-admission`、`machine-service-addresses`、`machine-terminal`、`managed-machines` 和 `node-lifecycle` 的既有用例，不宣称 runtime 全量通过。

## 行为证据

- 任务、告警、服务部署、运维和 Agent 首装创建提案时，在同一 SQLite 事务写入 capability_proposals；同 key 回放不重复，冲突不覆盖。
- 任务创建也显式包裹事务，索引与原生提案不会部分接受。索引只含 domain/native_id、来源、操作、状态和审阅地址，不含第二份正文。
- `lightmoni_domain_proposals_get` 返回各领域原生最新状态；任务/告警审批后统一 status=completed，部署/运维/Agent 首装保持 awaiting_approval。
- 列表在原生刷新后执行 domain/state 过滤，limit 分页、owner 隔离、proposals.read、领域 Scope 和 Host 授权生效；跨 owner 返回空集，错误 Host 不可见。
- 内部助手、MCP 和会话 HTTP 复用同一索引。官方 MCP 客户端发现并读取 task/alert 索引，status 与原生记录一致。
- 工具总数由 49 增至 51；原任务专用 lightmoni_proposals_get 保持兼容。OpenAPI/Bearer、执行索引、服务主体和持续授权未开放。

## 未验证与剩余范围

官方 MCP SDK 自动化不等于真实 Codex/Claude OAuth 或生产环境验收；本轮未执行这些验证。历史未索引记录不回填，跨领域执行索引、OpenAPI/Bearer、Agent 后续生命周期、服务回滚/核验和真实客户端矩阵仍需独立处理。

交付 PR：[workhold/lightmoni#214](https://github.com/workhold/lightmoni/pull/214)，目标为 main，依赖 #213；实现与验证完成，等待评审，未获本轮合并授权。
