# SDD 135 验证记录

验证日期：2026-11-14。范围为 Slice 1 描述符和 MCP 契约。分支以 SDD 134 的 `274c275` 为 stacked 基线；main 为 `65ebc79`，PR #186 在开发时仍 OPEN 且未合并。本切片未部署生产、未操作真实主机、未发布镜像、未改变 UI。

交付 PR：[workhold/lightmoni#187](https://github.com/workhold/lightmoni/pull/187)，目标为 main，依赖 #186；未合并。

## 自动化检查

| 检查 | 结果 | 覆盖 |
| --- | --- | --- |
| 核心、描述符、应用装配、MCP 能力/PAT/OAuth/Transport、助手任务与告警定向测试 | 66/66 通过 | 日志 `/tmp/lightmoni-slice1-targeted.log` |
| `npm --prefix runtime test` | 1794 项：1754 通过、35 跳过、5 失败 | 日志 `/tmp/lightmoni-slice1-runtime-full.log`；失败集合与 main 基线一致 |
| `npm run typecheck` | 通过 | runtime、ai-runtime、web |
| `npm run build` | 通过 | SDK、runtime、ai-runtime、web；日志 `/tmp/lightmoni-slice1-build.log`，仅有既有 Web 依赖警告 |
| Markdown 相对链接检查 | 通过 | 本切片 SDD 和变更文档 |
| `git diff --check` 与秘密模式扫描 | 通过 | 无空白错误、真实令牌或私钥 |

## 新增行为证据

1. 既有 9 项无告警定义和告警启用后的第 10 项均由静态元数据生成完整描述符；重复 ID/别名和缺失元数据会拒绝注册。
2. exposure 同时在 list 和 invoke 生效；隐藏能力直接调用返回 capability_not_found，Host 目标越权仍返回 resource_not_found。
3. data 输出 Schema 非法时返回 output_invalid，完整响应超限返回 result_too_large；审计记录 detail code，不返回未验证数据。
4. 每能力输入大小、频率、并发和 15 秒默认期限生效；专项测试覆盖拒绝、审计、并发槽释放和超时后恢复。
5. resultProjection 在输出校验前执行，auditPolicy=digest_only；既有领域安全视图不改成原始存储对象。
6. MCP outputSchema 使用成功/安全错误 anyOf Envelope；官方 SDK 对成功、idempotency_conflict 错误均完成实际校验。旧 error.code=conflict 保留，新增 detail_code=idempotency_conflict；通用 HTTP 同步验证兼容分类和细节。
7. 官方 SDK 以两页遍历扩展后的工具目录，无重复、无遗漏；直接分页测试覆盖跨凭据、篡改和目录变化 cursor 拒绝，每页重新校验 Principal。
8. MCP annotations 由描述符生成；read、proposal 的 readOnly/destructive/idempotent/openWorld 提示有断言，但未作为权限依据。

## main 基线失败

最终全量仍有以下 5 项：agent-host-admission、machine-service-addresses、machine-terminal、managed-machines、node-lifecycle 的既有断言。SDD 134 已在独立 `main@65ebc79` worktree 逐项复现相同失败；本 Slice 全量失败集合没有增加，新增 7 项测试全部通过。不能据此宣称 runtime 全量通过。

## 未覆盖与后续

- 官方 MCP SDK 互操作不等于真实 Codex/Claude 新 OAuth 或自然语言闭环；本切片未执行这些外部客户端验收。
- 未新增领域业务工具，未实现长任务异步化、代码任务持久化、跨领域完整索引、OpenAPI、普通程序 Bearer、服务主体或直接 execute。
- 按当前 AGENTS 仅维护仓库设计，不同步历史 Doca 副本。
