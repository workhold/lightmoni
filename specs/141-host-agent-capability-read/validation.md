# SDD 141 验证记录

验证日期：2026-11-14。范围为 Slice 2 主机与 Agent 只读。分支 stacked 在 SDD 140 的 `2f1c1bb` 上；main 为 `1c3b0e4`，PR #192/#193/#194 在开发时均 OPEN 且未合并。未部署生产、未操作真实主机、未发布镜像。

交付 PR：[workhold/lightmoni#195](https://github.com/workhold/lightmoni/pull/195)，目标为 main，依赖 #192/#193/#194；未合并。

## 自动化检查

| 检查 | 结果 | 覆盖 |
| --- | --- | --- |
| 全领域能力、真实主机管理/安装/Agent 更新、MCP 与助手定向测试 | 266 项：264 通过、1 跳过、1 失败 | `/tmp/lightmoni-host-agent-targeted.log`；唯一失败为 main 既有 managed-machines 卸载断言 |
| `npm --prefix runtime test` | 1821 项：1781 通过、35 跳过、5 失败 | `/tmp/lightmoni-host-agent-runtime-full.log`；失败集合与 main 基线一致 |
| `npm run typecheck` | 通过 | runtime、ai-runtime、web |
| `npm run build` | 通过 | `/tmp/lightmoni-host-agent-build.log`；仅有既有 Web 依赖警告 |
| Markdown 链接、`git diff --check`、秘密模式扫描 | 通过 | 无失效本地链接、空白错误、真实令牌或私钥 |

## 行为证据

- 新主机详细目录/详情使用 assistant-safe 视图；旧 hosts_get 不新增 ssh_credentials 字段，Host Key/秘密不泄露。
- Agent Release、安装和维护结果分别返回真实版本/SHA、unknown 安装和 rolled_back 维护，不把非成功状态改写为升级成功。
- Host 资源授权过滤详细目录，越权详情/维护返回 resource_not_found；安装结果按 machine_id 复验，Release 的 allHosts 限制拒绝有限主机授权。
- 成员不能读取主机/Agent 管理员领域，直接 invoke 不绕过。
- 内部五个旧工具名和输出形态保持，get_managed_machine 的 machine_id 显式映射到新详情 id；注册无重复，审计 source=assistant。
- 官方 MCP SDK 发现五个新能力，读取主机、安装和维护回执，无 propose/approve/apply/execute 工具。
- 告警模块启用时工具总数为 36。

## main 基线失败与未覆盖

最终全量仍只有 agent-host-admission、machine-service-addresses、machine-terminal、managed-machines、node-lifecycle 的 5 项既有失败；本切片没有新增失败，但不宣称 runtime 全量通过。

官方 MCP SDK 不等于真实 Codex/Claude OAuth 或自然语言验收；本切片未执行这些验证。远程预检、安装/升级/回退提案、卸载/恢复和其他生命周期写操作仍未开放。
