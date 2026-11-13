# SDD 136 验证记录

验证日期：2026-11-14。范围为 Slice 2 的遥测只读垂直切片。分支 stacked 在 SDD 135 的 `8baa9e4` 上；main 为 `65ebc79`，PR #186/#187 在开发时均 OPEN 且未合并。未部署生产、未操作真实主机、未发布镜像。

交付 PR：[workhold/lightmoni#188](https://github.com/workhold/lightmoni/pull/188)，目标为 main，依赖 #186/#187；未合并。

## 自动化检查

| 检查 | 结果 | 覆盖 |
| --- | --- | --- |
| 核心、描述符、遥测、应用装配、MCP/PAT/OAuth/Transport、助手与告警定向测试 | 87/87 通过 | `/tmp/lightmoni-telemetry-targeted.log`；包括真实 Mastra worker 和官方 MCP SDK |
| `npm --prefix runtime test` | 1799 项：1759 通过、35 跳过、5 失败 | `/tmp/lightmoni-telemetry-runtime-full.log`；5 项均为已复现的 main 基线失败 |
| `npm run typecheck` | 通过 | runtime、ai-runtime、web |
| `npm run build` | 通过 | `/tmp/lightmoni-telemetry-build.log`；仅有既有 Web 依赖警告 |
| Markdown 相对链接、`git diff --check`、秘密模式扫描 | 通过 | 无失效本地链接、空白错误、真实令牌或私钥 |

## 行为证据

- TelemetryService 统一承接内部旧工具和外部 catalog/describe/query；内部 run_query 审计 source=assistant，外部 MCP 查询 Query source=mcp。
- registerAssistant 在共享 Dispatcher 存在时过滤旧三工具，名称无重复；直接旧名称调用仍返回既有外层结构。
- telemetry.catalog.read 支持目录和表结构，但不能调用 telemetry.query；有限主机授权不能发现或直接调用三项遥测能力。
- 成员会话仅有 telemetry.catalog.read/telemetry.query，可继续内部遥测读取，但不能调用任务；scopesForUser(member) 为空，外部 PAT/OAuth 权限未扩大。
- 查询参数额外字段在 Query 前拒绝，反向时间范围不调用 Query；领域 error 不转成成功。
- 1200 行且含大正文的响应同时触发行/字节采样，sample_truncated/sample_byte_limited 均为 true，完整 Envelope 不超过 64 KiB；无法裁剪的超大元数据返回 result_too_large。
- 官方 MCP 客户端实际发现三项遥测工具、读取表结构、执行查询并校验 outputSchema；有限主机 PAT 的目录不显示遥测工具，直接调用返回 capability_forbidden。

## main 基线失败与未覆盖

最终全量失败仍是 agent-host-admission、machine-service-addresses、machine-terminal、managed-machines、node-lifecycle 的 5 项既有断言。它们已在 SDD 134 的独立 `main@65ebc79` worktree 复现；本切片没有新增失败，但不能宣称 runtime 全量通过。

官方 MCP SDK 测试不等于新的真实 Codex/Claude OAuth 或自然语言验收；本切片未执行这些外部客户端验证。日志/Trace 专用工具、大盘、部署、运维、Agent 生命周期及其他 Slice 2 领域仍待迁移。
