# SDD 168 展示契约

## 入口

- `linked=false` 且无待处理安装时，部署按钮同时显示图标和“部署 Agent”；其 Agent 下拉仍保留全部维护项。
- `linked=true` 或已有待处理安装时，Agent 下拉触发按钮显示图标和“Agent 管理”；无障碍名称继续包含具体主机名。
- 不根据新文字推断能力，原有 `capabilities`、禁用原因、管理员角色和 pending 状态仍是唯一行为依据。

## 安装与恢复语义

- 普通安装 apply 的请求、按钮名称和确认流程不变，只移除危险视觉样式。
- `mode=recovery`、恢复原因、purge、revision、有效期和远端核验不变；显示名称不再追加“强制”。

## 卸载状态与完成

- 对话框标题中的 Alert 是主状态标题；进度组件可隐藏自己的重复状态文字，但必须保留真实阶段、进度条、错误和只读核对提示。
- `succeeded` 只来自原记录。成功回执保持原字段，显示顺序早于折叠的原计划；折叠/展开不触发请求。
- “完成”只调用原 `onClose`，不调用 apply、reconcile、refresh、部署或任何新的写操作。
- `awaiting_approval/running/failed/unknown/cancelled` 的原有计划、核对、取消、刷新和防重复提交行为不得改变。
