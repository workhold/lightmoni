# SDD 138 验证记录

验证日期：2026-11-14。基线为已合入 SDD 134～137 的 `main@1c3b0e4`。范围为 Slice 2 日志与 Trace 只读能力；未部署生产、未操作真实主机、未发布镜像。

交付 PR：[workhold/lightmoni#192](https://github.com/workhold/lightmoni/pull/192)，目标为 main；未合并。

## 自动化检查

| 检查 | 结果 | 覆盖 |
| --- | --- | --- |
| 核心、描述符、遥测、原/新告警、日志/Trace、domains、MCP 与助手定向测试 | 135/135 通过 | `/tmp/lightmoni-log-trace-targeted.log` |
| `npm --prefix runtime test` | 1809 项：1769 通过、35 跳过、5 失败 | `/tmp/lightmoni-log-trace-runtime-full.log`；失败集合与 main 基线一致 |
| `npm run typecheck` | 通过 | runtime、ai-runtime、web |
| `npm run build` | 通过 | `/tmp/lightmoni-log-trace-build.log`；仅有既有 Web 依赖警告 |
| Markdown 链接、`git diff --check`、秘密模式扫描 | 通过 | 无失效本地链接、空白错误、真实令牌或私钥 |

## 行为证据

1. Logs.searchRead 使用真实 ownerID/AbortSignal；原 `/logs/search` 冻结分页、owner、到期、SQL filters 和 domains 30 项回归通过。
2. 新日志能力首页与后续页共用同一 Session Map，第二页不重新执行 Query；其他用户读取该 session 返回原过期/不可用边界。
3. 大日志页被裁剪时 capability_truncated=true，next_cursor=offset+实际返回行数；后续两页依次返回被裁剪的 b/c 行且不重新查询。单条超限返回 result_too_large，不产生重复游标。
4. Trace 新能力返回真实 span；缺父节点时 incomplete=true、missing_parents=1，非 Trace 表被拒绝。原 HTTP 复用同一 TraceReadService。
5. logs.read/traces.read 相互独立，有限主机授权不能发现或调用；成员内部读取可用但外部 Scope 仍仅管理员。
6. 内部 search_logs/get_trace 使用 Dispatcher，真实注册无重复，审计 source=assistant。
7. 官方 MCP SDK 完成两个工具发现、日志首页/下一页和 Trace 调用，outputSchema 校验通过。
8. 告警模块启用时工具总数为 20；未新增保存检索、导出、审批或领域写工具。

## main 基线失败与未覆盖

最终全量仍只有 agent-host-admission、machine-service-addresses、machine-terminal、managed-machines、node-lifecycle 的 5 项既有失败；本切片没有新增失败，但不宣称 runtime 全量通过。

官方 MCP SDK 不等于真实 Codex/Claude OAuth 或自然语言验收；本切片未执行这些外部客户端验证。大盘、部署、运维、主机/Agent 和其他 Slice 2 能力仍待迁移。
