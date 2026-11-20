# SDD 192：Agent 生命周期围栏闭环

## 背景

Agent 首装、升级、卸载、任务执行和受管操作已有独立 unknown 围栏，但历史首装 executor bootstrap 表在统一 Agent 发行后不再有原生核对入口。生产中该表的 unresolved `unknown` 记录会继续阻塞升级/卸载，且 `/machines/:id/busy` 只显示内存车道，不显示数据库围栏，导致管理员只能看到泛化的 `maintenance_execution_pending`。

## 目标

1. 建立唯一的机器维护围栏投影：同时暴露内存 busy 与数据库 blocker。
2. 为遗留 `machine_executor_bootstraps.status='unknown'` 提供管理员、显式确认、留因、可审计的闭环入口。
3. 闭环只基于当前同机、同 Agent、更新的 active executor 心跳证据；不执行远端写入、不重放首装、不把历史 unknown 改成成功。
4. 保持现有安装、卸载、升级和任务 unknown 语义不变；运行中/待核对记录仍阻塞。
5. 让升级/卸载前的泛化错误携带 blocker 明细，便于页面和 AI 指向真实恢复入口。

## 非目标

- 不自动清理任何 unknown。
- 不恢复旧 executor 独立安装流程。
- 不绕过 SSH 只读核对、审批、权限和审计。
- 不把 AI/MCP 提升为直接执行权限。

## 验收

1. busy 响应包含 `maintenance_blockers`，能列出 unresolved executor bootstrap、task run、agent job、privileged job。
2. 仅管理员交互会话可调用遗留 bootstrap 闭环；缺少确认或原因被拒绝。
3. 无当前 active executor、executor 心跳过期、Agent/主机不匹配、状态非 unknown 或已闭环时拒绝。
4. 闭环后历史状态仍为 `unknown`，新增 resolved 元数据与 `privileged_audit` 记录，维护围栏不再把它视为 blocker。
5. Agent 维护准备失败返回 blocker 明细，不再只有 `maintenance_execution_pending`。
6. 相关 Runtime API 回归、类型检查和 `git diff --check` 通过。
