# SDD 144 验证记录

验证日期：2026-11-14。范围为 Slice 2 的 SDK 插桩只读。分支 stacked 在 SDD 142 的 `6248dbc` 上；main 为 `a38e390`，PR #192～#197 在开发时均 OPEN 且未合并。未部署生产、未操作真实主机、未发布镜像。

交付 PR：[workhold/lightmoni#198](https://github.com/workhold/lightmoni/pull/198)，目标为 main，依赖 #192～#197；未合并。

## 自动化检查

| 检查 | 结果 | 覆盖 |
| --- | --- | --- |
| 全领域能力、真实插桩工作区/Apply、MCP 与助手定向测试 | 282 项：280 通过、1 跳过、1 失败 | `/tmp/lightmoni-instrumentation-targeted.log`；唯一失败为 main 既有主机卸载断言 |
| `npm --prefix runtime test` | 1829 项：1789 通过、35 跳过、5 失败 | `/tmp/lightmoni-instrumentation-runtime-full.log`；失败集合与 main 基线一致 |
| `npm run typecheck` | 通过 | runtime、ai-runtime、web |
| `npm run build` | 通过 | `/tmp/lightmoni-instrumentation-build.log`；仅有既有 Web 依赖警告 |
| Markdown 链接、`git diff --check`、秘密模式扫描 | 通过 | 无失效本地链接、空白错误、真实令牌或私钥 |

## 行为证据

- 真实临时工作区扫描识别 LightMoni SDK 与请求边界；目录逃逸被拒绝，不执行项目代码。
- InstrumentationService.read 返回既有 plan 和 applied=null，不暴露 before 快照；原 propose/Apply 与加密存储回归通过。
- code.workspace.read 不能读取完整提案，detail Scope 独立；有限主机和成员不能发现/调用。
- 内部 scan_sdk_instrumentation 与新增 get_sdk_instrumentation 使用同一共享服务和 Dispatcher，注册无重复，审计 source=assistant。
- 官方 MCP SDK 完成扫描、提案读取和 outputSchema 校验，无 propose/apply/code_task 工具。
- 告警模块启用时工具总数为 41。

## main 基线失败与未覆盖

最终全量仍只有 agent-host-admission、machine-service-addresses、machine-terminal、managed-machines、node-lifecycle 的 5 项既有失败；本切片没有新增失败，但不宣称 runtime 全量通过。

官方 MCP SDK 不等于真实 Codex/Claude OAuth 或自然语言验收；本切片未执行这些验证。插桩生成/应用、code_task、代码任务结果读取和通用源码能力仍未开放，代码任务需后续独立设计与验证。
