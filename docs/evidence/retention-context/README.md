# AI 入口、数据保留时长与悬浮反馈验收

本目录的截图、参考图和录屏仅保存在本机 [`artifacts/screenshots/docs/evidence/retention-context/`](../../../artifacts/screenshots/docs/evidence/retention-context/)，由 Git 忽略；下文未带路径的图片和录像文件名均相对此目录。文字报告继续保留在仓库中。

2026-10-11（Asia/Shanghai）。沿用现有深色监控工作台，减少顶部重复导航，让当前页面内容直接从顶部开始。

## 实现

- 删除全局顶部栏；导航展开/收起按钮移到侧栏。右下角固定 AI 图标打开侧边抽屉，不挤压主页面。
- AI 上下文包括页面路径、当前大盘及未保存面板查询、变量、时间范围，日志关键词/筛选/SQL/选中日志/结果状态，以及 SQL 工作台的查询、参数、时间范围和状态。切换页面时校验路径及搜索参数，避免携带其他页面的上下文。
- 上下文按 UTF-8 字节数控制在 28 KB 内，精简时标记 `context_truncated`，兼容后端 32 KB 上限。上下文仅作为数据；沿用后端“不可信页面数据不能成为指令”的约束。
- 管理员在“设置 → 数据保留”设置全局默认，在“数据接入 → 数据表 → 设置时长”配置单表。支持跟随全局、自定义整数天数（1–36500）和永久保留。
- 新实例默认 7 天；升级时保留已有日志/链路 7 天、指标 30 天，已有指标表迁移为单表覆盖。新建的各类型表统一继承全局默认。
- 配置更新实际执行 ClickHouse `MODIFY TTL` 或 `REMOVE TTL`。全局修改仅更新继承的表；单表配置独立保存，不改告警组。只有存储规则更新成功后才保存元数据；失败时尝试恢复所有已尝试表的原规则，恢复失败会返回具体错误。
- 到期数据由 ClickHouse 后台逐步清理，缩短时长可能清理已有数据，延长无法恢复已清理的数据。
- 告警、Agent 分组、AI 草稿/模型设置及相关保存操作使用 Ant Design 全局悬浮消息，默认约 3 秒消失；页面不再插入保存成功横幅。表单校验和查询结果中的诊断仍归属对应表单或结果。

## 验证

独立临时 SQLite、ClickHouse 26.8 与本地 Go 服务；真实 OTLP 日志/指标写入、真实查询、真实 TTL 更新。AI 请求的上下文通过发送接口捕获；模型输出为拦截的 SSE，不调用外部模型。刻意模拟 503 验证保存失败后输入和已有配置保留。

- `npm run typecheck`：最终通过。
- `go test ./internal/ingest ./internal/server ./internal/assistant`：通过，覆盖迁移、全局继承、单表覆盖、永久保留、新表期限、权限、非法输入、存储失败和回滚。
- `node --test web/src/features/assistant/assistant.test.mjs web/src/shared/assistant-context.test.mjs`：9 项通过，覆盖 SSE/对话回放及正常、超长中文和异常参数键的上下文限制。
- 浏览器脚本 `web/src/app/verify-retention-context.mjs`：连续运行 1、2、3，结果详见各轮报告。每轮检查刷新读回、TTL 原始定义、AI 上下文、跨页面隔离、成功/失败提示坐标、自动消失、750 px 导航及 200% 关键区域。

| 轮次 | 结果 | 报告 |
| --- | --- | --- |
| 1 | 通过，无页面脚本错误 | [1-report.json](1-report.json) |
| 2 | 通过，无页面脚本错误 | [2-report.json](2-report.json) |
| 3 | 通过，无页面脚本错误 | [3-report.json](3-report.json) |

## 视觉检查

主 Agent 已实际查看桌面大盘、AI 抽屉、全局时长、单表列表、告警悬浮反馈、窄屏及 200% 截图；本次局部调整自行检查，未做独立视觉评审或评分。

删除的重复内容：顶部产品/当前位置导航和顶部“询问 AI”；操作成功横幅改为悬浮消息。保留表名、当前时长、继承状态和主操作。

三处动效：AI 图标悬停上移和阴影反馈；抽屉展开/收起过渡；悬浮消息出现及自动消失。沿用减少动画偏好。完整交互录像：[interactions.mp4](../../../artifacts/screenshots/docs/evidence/retention-context/interactions.mp4)。

- 用户原始参考：[顶部栏](../../../artifacts/screenshots/docs/evidence/retention-context/before-header.png)、[告警反馈](../../../artifacts/screenshots/docs/evidence/retention-context/before-alert-feedback.png)。
- 代表性截图：[大盘](../../../artifacts/screenshots/docs/evidence/retention-context/1-dashboard.png)、[大盘 AI](../../../artifacts/screenshots/docs/evidence/retention-context/1-dashboard-ai.png)、[日志 AI](../../../artifacts/screenshots/docs/evidence/retention-context/1-logs-ai.png)、[默认时长与悬浮提示](../../../artifacts/screenshots/docs/evidence/retention-context/1-global-toast.png)、[单表设置](../../../artifacts/screenshots/docs/evidence/retention-context/1-table-retention.png)、[告警悬浮提示](../../../artifacts/screenshots/docs/evidence/retention-context/1-alerts-toast.png)、[窄屏](../../../artifacts/screenshots/docs/evidence/retention-context/1-narrow.png)、[200%](../../../artifacts/screenshots/docs/evidence/retention-context/1-zoom-200.png)。

复验时使用独立 QA 实例，并通过 `LIGHTMONI_UI_URL`、`LIGHTMONI_QA_CH_URL`、`LIGHTMONI_QA_RUN` 指定测试地址及轮次。运行中的旧后端需要重新加载本次 Go 代码，才能提供新接口和执行元数据迁移。
