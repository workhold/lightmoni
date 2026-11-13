# SDD 134 验证记录

验证日期：2026-11-14。基线为 `main@65ebc79`，范围为 Slice 0 核心解耦。未部署生产、未操作真实主机、未发布镜像；本切片没有 UI 变化，也没有新增真实 Codex/Claude OAuth 或自然语言验收。

## 自动化检查

| 检查 | 结果 | 范围 |
| --- | --- | --- |
| 核心、应用装配、MCP 能力/PAT/OAuth/Transport、助手任务与告警定向测试 | 59/59 通过 | 包括真实 Mastra worker fixture、无 MCP 的核心 HTTP 和助手工具、外部提案失败关闭及外部授权委托 |
| `npm --prefix runtime test` | 1787 项：1747 通过、35 跳过、5 失败 | 最终全量日志为 `/tmp/lightmoni-slice0-runtime-final.log`；5 项均在未修改 main 基线复现，见下节 |
| `npm --prefix ai-runtime test` | 71/71 通过 | 模型协议、worker、usage 与取消等既有范围 |
| `npm --prefix sdk/typescript test` | 28/28 通过 | 包含构建后 SDK 测试 |
| `npm run typecheck` | 通过 | runtime、ai-runtime、web |
| `npm run build` | 通过 | TypeScript SDK、runtime、ai-runtime、web；Web 仅有既有依赖构建警告 |
| `git diff --check` | 通过 | 无空白错误 |

## runtime 全量失败与基线对比

最终全量有以下 5 项失败：

1. `agent-host-admission.test.ts`：orphan/revoked identity 的状态码断言。
2. `machine-service-addresses.test.ts`：NAT service address/network 读取断言。
3. `machine-terminal.test.ts`：真实 SSH 清理后的 secret 非空断言。
4. `managed-machines.test.ts`：unbound host uninstall 的状态断言。
5. `node-lifecycle.test.ts`：archived node operations plan 的状态码断言。

在独立 detached worktree `/tmp/lightmoni-slice0-baseline` 的 `main@65ebc79` 上逐文件复跑，上述 5 项以相同断言失败。它们不属于本切片修改文件或能力路径，本切片没有新增全量失败；这些基线问题仍需独立修复，不能据此宣称 runtime 全量通过。

首次定向运行中的 Mastra worker 用例因 ai-runtime 尚未安装/构建而失败，执行锁定依赖 `npm --prefix ai-runtime ci` 和构建后通过。首次全量另有一项 Web `yaml` 依赖缺失，执行 `npm --prefix web ci` 后单独通过；最终全量不包含该环境失败。新增外部授权委托测试的中间断言曾错误要求三次校验，修正为实际的一次调用校验和一次审批 grant 校验后通过；最终全量包含修正后的测试并通过。

## 行为证据

- 无 MCP Access 时，核心数据库表、能力发现/调用 HTTP、Web Principal 和助手 `list_tasks` 均可用，审计分别记录 `web`/`assistant`。
- 无 MCP Access 时，伪造或历史外部 Principal/提案返回授权不可用；外部提案保持 awaiting_approval，Task Run 和审批审计均不增加。
- 同一 fixture 中内部助手提案仍完成原有审批并只创建一个排队执行。
- 可选外部适配器存在时，MCP Principal 和稳定 grant 均通过委托校验，原外部任务提案审批与执行关联不变。
- 真实 createApp 使用非 loopback HTTP externalURL 时仍装配核心与助手路由，但不创建 MCP Access 表；MCP 禁用路由保留。

## 未覆盖与后续

- 未执行生产环境、真实 ClickHouse/SSH 主机、真实 Codex/Claude OAuth 新矩阵；既有失败和 35 个跳过项不作为通过能力。
- 本切片没有扩展业务工具、描述符版本、输出 Schema 或普通程序 Bearer；这些属于后续 Slice。
- 按当前仓库 AGENTS，仅维护仓库设计文档，不同步历史 Doca 副本。
