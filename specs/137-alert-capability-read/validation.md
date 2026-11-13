# SDD 137 验证记录

验证日期：2026-11-14。范围为 Slice 2 的告警只读垂直切片。分支 stacked 在 SDD 136 的 `adca42a` 上；main 为 `65ebc79`，PR #186/#187/#188 在开发时均 OPEN 且未合并。未部署生产、未操作真实主机、未发布镜像。

交付 PR：[workhold/lightmoni#190](https://github.com/workhold/lightmoni/pull/190)，目标为 main，依赖 #186/#187/#188；已于 2026-11-14 获用户授权合入 main，merge commit `7f12dd9`。

## 自动化检查

| 检查 | 结果 | 覆盖 |
| --- | --- | --- |
| 核心、描述符、遥测、原/新告警、MCP/PAT/OAuth/Transport、助手定向测试 | 99/99 通过 | `/tmp/lightmoni-alert-targeted-final.log` |
| 原告警 API + 新告警读取 + 助手 + MCP 恢复复验 | 27/27 通过 | `/tmp/lightmoni-alert-restoration.log` |
| `npm --prefix runtime test` | 1803 项：1763 通过、35 跳过、5 失败 | `/tmp/lightmoni-alert-runtime-final.log`；失败集合与 main 基线一致 |
| `npm run typecheck` | 通过 | runtime、ai-runtime、web |
| `npm run build` | 通过 | `/tmp/lightmoni-alert-build.log`；仅有既有 Web 依赖警告 |
| Markdown 链接、`git diff --check`、秘密模式扫描 | 通过 | 无失效本地链接、空白错误、真实令牌或私钥 |

## 测试完整性修正

开发中曾把新增测试写到已有 `alert-capabilities.test.ts`，造成 8 项原测试被替换。通过全量计数和前次日志差异识别后，已恢复原文件，并将 3 项新测试移到独立 `alert-read-capabilities.test.ts`。最终定向 99 项包含原 8 项；最终全量同时出现并通过原告警 API 和新告警读取测试。中间日志不作为最终通过证据。

## 行为证据

- AlertReadService 统一规则筛选/分页、完整规则、静默、责任组和提案读取；publicAlertValue 保持大整数十进制字符串语义。
- 原 alerts_list 保留 `{rules,limit}`；新增六个读取工具，告警模块启用时描述符总数为 18，无 apply/approve/propose 外部工具。
- alerts.read 的规则列表无 SQL；rules_get 和 proposals_get 需要 alerts.detail.read。有限主机授权不能发现或直接调用告警能力。
- 责任组只返回 id/name/enabled，成员、联系人或测试秘密字段不进入结果；他人提案读取失败，本用户提案返回真实 awaiting_approval。
- 成员内部会话可继续告警读取但不能读取任务；外部 Scope 仍只向管理员开放。
- 内部六个旧工具名均由 Dispatcher 适配器提供，真实注册无重复；告警写入仍由原 ProposalService 和人工审批处理。
- 官方 MCP SDK 完成六个新工具发现、规则列表/详情、提案读取和普通 Scope 越权拒绝。
- 提案读取保留 ProposalService 的 48 KiB 预览/回执边界，未误用普通 32 KiB 读取上限。

## main 基线失败与未覆盖

最终全量仍只有 agent-host-admission、machine-service-addresses、machine-terminal、managed-machines、node-lifecycle 的 5 项既有失败；本切片没有新增失败，但不宣称 runtime 全量通过。

官方 MCP SDK 不等于新的真实 Codex/Claude OAuth 或自然语言验收；未执行这些外部客户端验证。告警写入属于 Slice 3，日志/Trace、大盘、部署、运维和其他领域仍待迁移。
