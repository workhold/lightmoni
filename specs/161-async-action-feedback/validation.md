# SDD 161 验收记录

## 行为与证据

- 主机详情入口的受控延迟请求显示行内 loading，双击只发一次 GET；跨主机及深链迟到响应不覆盖后来选择。
- 已有 Agent 更新从主机行打开最新主机详情中的原操作 ID，不发起新的 `start`；旧列表中的 ID 与最新详情不同时，以最新详情为准。
- 一键升级启动期间有明确等待提示；即使关闭窗口，主机行仍锁定，直到原请求完成且主机回读结束。运行阶段和最终结果来自服务端记录。
- 待审批计划直接显示 SSH 目标、固定目标包 SHA、安装指纹、执行步骤和影响；批次待审批的每机计划默认展开，其他技术详情及完整阶段日志可按需查看。
- 任务中心手动刷新、告警响应操作和运维结果刷新使用各自的 loading，失败后恢复；结果抽屉关闭并重开同一执行记录时，旧刷新不能覆盖新会话。

视觉核对：[运行中](evidence/upgrade-progress.png)、[结果](evidence/upgrade-result.png)、[390px 窄屏](evidence/upgrade-mobile.png)。

## 检查结果

| 检查 | 结果 |
| --- | --- |
| `npm --prefix web run build`（含 TypeScript 检查） | 通过 |
| `node scripts/test-agent-update-direct-ui.mjs` | 13 项通过；包含延迟请求、原操作续接、启动中关闭、旧列表 ID、审批内容和窄屏 |
| `node web/src/app/verify-task-center.mjs` | 18 项通过；包含手动刷新 loading、防重复和失败重试 |
| `node web/src/features/alerts/verify-response.mjs` | 8 项通过 |
| `git diff --check` | 通过 |

附带检查：`verify-host-identity-requests.mjs` 在“系统主机名：system-a”旧断言处失败；同样失败在未修改的 `origin/main`（`5076f64`）上复现，此问题不由 SDD 161 引入。

## 架构同步

架构影响：**不适用**。仅修改现有前端状态和展示，不变更组件职责、数据/控制路径、凭据边界、存储、协议或部署拓扑。仓库系统设计章节、Doca 链接及回读结果均不适用；无需改写 `docs/system-design.md` 或 Doca。
