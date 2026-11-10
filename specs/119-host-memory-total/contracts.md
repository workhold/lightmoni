# 展示契约

- 沿用 `GET /api/v1/machines/:id` 的 `machine.capacity.memory_total_mb`，字段为 MiB，显示 `memory_total_mb / 1024` 的一位小数 GiB。
- 内存面板 ID 仍为 `host-memory`；既有 used/available/total 曲线、查询参数、单位及刷新不变。
- 有效有限正数显示总内存；缺失/非正数/无效值显示“内存 · 总内存未知”或“Memory · total unknown”。
- 当前机器与容量变更后使用原 React 状态渲染新标题；不增加 API、Agent 行为或权限。
