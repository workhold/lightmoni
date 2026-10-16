# 两层告警门槛验证

本目录的截图、参考图和录屏仅保存在本机 [`artifacts/screenshots/docs/evidence/alert-policy/`](../../../artifacts/screenshots/docs/evidence/alert-policy/)，由 Git 忽略；下文未带路径的图片和录像文件名均相对此目录。文字报告继续保留在仓库中。

对应规则说明：[告警与通知规则对齐](../../alert-rules-and-notifications.md)。

界面沿用现有 Ant Design 表单、颜色及双栏/窄屏单栏布局。规则层使用“连续异常检测次数”，通知层使用“夜间持续告警轮数”，并在通知策略中说明两者独立。保留原有成员、排班、等级与升级入口，夜间专属字段按策略显隐。缩短连续检测字段的帮助文字，并解释规则提醒事件与人员组实际通知间隔的区别。

## 验证结果

- `go test -race ./internal/alerts ./internal/dashboards` 通过。覆盖突刺、连续检测正常/失败/中断清零、次数与时长同时满足、API保存及校验、已触发后的夜间轮次、重复扫描不计数、模块重新初始化、不同实例隔离、P0全天双渠道、P2夜间仅记录及次日历史、昼夜切换、发送前渠道检查及旧配置兼容。
- `npm run typecheck` 通过；17个告警预览、响应模型和图表告警单元测试通过。
- 主Agent连续运行 `node web/src/features/alerts/verify-alert-policy.mjs` 三次，每次通过。覆盖独立保存、刷新回读、409保存失败保留输入、旧组不自动开启夜间电话，以及390px策略与规则表单操作。最终机器报告为 `report.json`。
- 原告警响应浏览器流程通过，包括接手、统计、组策略保存、静默、联系方式和Trace；报告为 `response-regression-report.json`。验证产生的旧目录截图已还原，避免覆盖先前验收证据。

浏览器使用受控接口数据，后端使用隔离SQLite及真实本地HTTP接收器；没有调用真实供应商或发送付费短信、电话。未启动或部署替换用户现有后端服务。

## 视觉证据

- `before.png`：改动前等级策略基线。
- `policies-desktop.png` / `policies-mobile.png`：夜间通知方式、独立轮数及间隔说明。
- `rule-desktop.png` / `rule-mobile.png`：连续异常检测次数、持续时长和相关帮助文字。

主Agent已查看桌面和窄屏截图，无独立视觉评审、未评分。保留既有按钮按压和标签切换反馈，新夜间字段沿用既有淡入规则并尊重减少动态效果偏好；本次截图在减少动态效果模式下生成，不将静态截图作为动效验收证据。
