# 契约

- 无新增或修改 HTTP/MCP/SSH 接口。沿用 `openTerminal`、`openCheck`、`openPlan`、`openUninstall`、`openUpdate` 与既有请求目标/代次校验。
- `accountRepairable()` 的诊断入口维持可达；不把所有 `available=false` 统一视为禁用。
- `ssh_recovery_available` 只显示凭据配置状态，不宣称实时连通。
- 已移除/卸载状态优先于陈旧发行元数据；未知结果不因折叠、刷新或重新打开菜单而变成成功或自动重放。
- 主列表网络概览仅使用 `service_addresses` 的有效地址与确认标记；完整发现信息仍在详情展示。
- 所有批处理继续使用原选择快照、数量限制、逐项检查、审阅及确认。
