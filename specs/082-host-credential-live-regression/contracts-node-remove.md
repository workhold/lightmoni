# Agent 移除与独立 root 执行器契约

## 问题

`POST /api/v1/agents/:id/remove` 原有门禁未覆盖独立 root 执行器。移除会撤销普通 Agent 身份并写入 tombstone，导致执行器后续认证因 `agent_removed` 拒绝，但执行器平台身份仍未撤销，远端 root 服务仍然安装。

## 约束

- 与普通 Agent 卸载和主机删除使用同一生命周期顺序：先核实独立 root 执行器已卸载并撤销，再移除普通 Agent。
- 当目标 Agent 对应任一未撤销执行器（包括待安装、已激活、结果未知状态）时，移除返回 HTTP 409，并提示先卸载并撤销 root 执行器。
- 检查与 tombstone、普通凭据撤销及审计写入位于同一数据库事务中；拒绝时以上记录均不得改变，也不得擅自撤销独立执行器。
- 只有其他主机/Agent 的未撤销执行器不阻止本 Agent 移除；本 Agent 的历史已撤销执行器不阻止移除。
- 已移除 Agent 的重复请求维持原有幂等结果，不借重试修改历史执行器或审计。

## 验证

使用隔离数据库和本机 HTTP fixture，覆盖 pending、active、生产未知安装状态 bootstrap_unknown，以及任意非 revoked 状态（以 unknown 验证）的拒绝及无副作用、历史 revoked 允许、其他主机隔离；不得通过真实主机移除复现缺陷。

## 架构影响

不适用：补齐现有 Agent / 独立 root 执行器生命周期约束，未改变组件职责、权限、协议或拓扑。
