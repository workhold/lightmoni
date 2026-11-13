# SDD 142 验证记录

验证日期：2026-11-14。范围为 Slice 2 大盘只读。分支 stacked 在 SDD 141 的 `801597b` 上；初始 main 为 `1c3b0e4`，PR #192～#195 在开发时均 OPEN 且未合并。未部署生产、未操作真实主机、未发布镜像。

交付 PR：[workhold/lightmoni#197](https://github.com/workhold/lightmoni/pull/197)，目标为 main，依赖 #192～#195；未合并。提交前已同步包含 #196 的最新 origin/main。

## 自动化检查

| 检查 | 结果 | 覆盖 |
| --- | --- | --- |
| 全领域能力、真实大盘/版本、MCP 与助手定向测试 | 270 项：268 通过、1 跳过、1 失败 | `/tmp/lightmoni-dashboard-targeted.log`；唯一失败为 main 既有 managed-machines 卸载断言 |
| `npm --prefix runtime test` | 1825 项：1785 通过、35 跳过、5 失败 | `/tmp/lightmoni-dashboard-runtime-full.log`；失败集合与 main 基线一致 |
| `npm run typecheck` | 通过 | runtime、ai-runtime、web |
| `npm run build` | 通过 | `/tmp/lightmoni-dashboard-build.log`；仅有既有 Web 依赖警告 |
| Markdown 链接、`git diff --check`、秘密模式扫描 | 通过 | 无失效本地链接、空白错误、真实令牌或私钥 |

## 行为证据

- DashboardReadService 使用真实 Dashboards 和 SQLite；自定义/系统目录均可见，自定义搜索/分页返回摘要且无 panels 字段。
- 完整详情保留面板定义，版本历史返回 revision=1 的真实记录；不存在对象和超大详情分别返回 not_found/result_too_large。
- dashboards.read 不能读取完整详情，dashboards.detail.read 独立控制；有限主机授权不能发现/调用。
- 成员内部会话可读取既有共享大盘；外部 Scope 仍只向管理员开放。
- 内部 list_dashboards/get_dashboard/get_dashboard_versions 使用 Dispatcher，注册无重复，审计 source=assistant。
- 官方 MCP SDK 发现三个能力，读取真实目录、详情和版本，并验证普通 Scope 越权拒绝；无 save/copy/delete/draft 工具。
- 告警模块启用时工具总数为 39。

## main 基线失败与未覆盖

最终全量仍只有 agent-host-admission、machine-service-addresses、machine-terminal、managed-machines、node-lifecycle 的 5 项既有失败；本切片没有新增失败，但不宣称 runtime 全量通过。

官方 MCP SDK 不等于真实 Codex/Claude OAuth 或自然语言验收；本切片未执行这些验证。保存、复制、删除、告警草稿和 AI draft_dashboard 外部化未开放；后续 Slice 3 与其他领域仍需完成。
