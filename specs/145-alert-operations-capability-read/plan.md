# 实施计划

## 1. 共享事件与投递读取

- 将 Alert API 的 filteredIDs 逻辑迁为 AlertReadService 可复用函数。
- AlertReadService 增加 nativeIncidents/getIncident/nativeDeliveries，以及模型安全分页投影。
- 原 incidents/deliveries 路由改为共享服务委托，保持原响应。

## 2. 描述符与权限

- incidents.list 使用 alerts.incidents.read，返回安全摘要。
- incidents.get 使用 alerts.incidents.read，返回真实 incident+timeline，60 KiB 有界。
- deliveries.list 使用 alerts.notifications.read，返回安全状态/关联字段，省略联系人、payload、供应商响应和原始错误。
- 全部 allHosts=true，admin/member 内部读取；外部 Scope 仍管理员专用。

## 3. 内部助手与 MCP

- Dispatcher 添加 list_alert_incidents/get_alert_incident/list_alert_deliveries。
- MCP 接入页增加两个 Scope 的中英文标签。
- 官方 SDK 验证三个能力、状态和权限。

## 4. 验证与交付

- 添加真实 Alerts/Outbox、筛选、权限、内部助手和 MCP 客户端测试。
- 复跑原/新告警、通知、domains、核心和其他领域回归。
- 执行全仓类型检查、构建和 runtime 全量；main 既有失败单独对照。
- 更新系统设计、平台 MCP 和接入指南，推送 stacked 分支并创建面向 main 的 PR，注明依赖 #192～#198，不合并。
