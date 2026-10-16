# Agent 分组标签页、阈值线与告警跳转

本目录的截图、参考图和录屏仅保存在本机 [`artifacts/screenshots/docs/evidence/agent-alert-workflow/`](../../../artifacts/screenshots/docs/evidence/agent-alert-workflow/)，由 Git 忽略；下文未带路径的图片和录像文件名均相对此目录。文字报告继续保留在仓库中。

沿用现有监控后台的颜色、控件和密度，把分组、图表与告警配置的对应关系直接显示出来。没有重新设计其他页面。

- 每个 Agent 分组是一个 Tab，默认分组排在首位。分组任务和 Agent 列表属于同一标签页，切换后刷新仍保留当前分组。
- 图表按所属面板及显式绑定的规则加载阈值。保存告警立即生效，尚未保存大盘绑定也能显示；保存告警后直接返回大盘会刷新阈值，重新打开告警设置能读回这些条件。阈值采用对应 Y 轴及单位，多条相近阈值的标签错开；类别柱图也能显示阈值。
- 规则列表、事件列表与事件详情都显示“大盘告警设置”链接。点击打开对应大盘的图表编辑器，直接进入“告警”标签页；窄屏自动打开设置抽屉。复制大盘时优先列出告警所属面板。

## 验证

主 Agent 自检，未安排独立视觉评审，不给虚构评分。查看桌面、390px 设置抽屉的实际输入操作及 200% 图表局部。移除了分组选择下拉，复用现有 Tab，新增“大盘 / 图表”链接而没有增加重复说明。

| 验证脚本 | 第 1 次 | 第 2 次 | 第 3 次 |
| --- | --- | --- | --- |
| Agent 分组、保存失败重试、刷新、改组及接入 | 通过 | 通过 | 通过 |
| 阈值画布、左右轴、显示开关、保存失败重试、规则/事件跳转 | 通过 | 通过 | 通过 |

Agent 报告与截图位于 `../agent-groups/verification-tabs-{1,2,3}.json`、`../agent-groups/groups-tabs-3.png`。告警报告为 `verification-{1,2,3}.json`，截图为 `thresholds-3.png`、`alert-list-3.png`、`alert-settings-3.png`、`narrow-settings-3.png`，窄屏抽屉内容为 `narrow-settings-body-3.png`，200% 局部为 `threshold-200.png`。保留 `before-agents.png`、`before-threshold.png` 作为局部基线。

沿用三处反馈：Tab 指示条切换、图表编辑器/窄屏设置抽屉展开、保存加载与结果反馈。实际交互录像为 `interaction-1.webm`。

类型检查通过，前端告警模型 8 项测试通过；后端 `TestAnnotations*`、`TestChartGroupsOverrideTableRoutes`、`TestChartNoData*` 通过，覆盖面板归属、显式绑定合并去重、窗口范围、空面板以及原有告警求值。

验证使用隔离的临时 SQLite，配置保存及刷新读回调用真实 API。图表查询结果和事件列表使用受控数据；QA 服务未运行通知发送循环，没有发送外部通知。用户随后请求启动，现已更新本地 Docker 实例 `http://localhost:18380`。沿用原有持久卷；健康检查、22 个前端文件与构建字节校验、分组/大盘/面板告警接口检查通过，见 `deployment.json`。

## 复现

```sh
go run ./scripts/ingestion-qa
LIGHTMONI_DEV_API_URL=http://127.0.0.1:18882 npm --prefix web run dev -- --port 5178 --strictPort
```

后端与 Vite 启动后，依次运行：

```sh
LIGHTMONI_QA_RUN=tabs-1 node web/src/app/verify-agents.mjs
LIGHTMONI_QA_RUN=tabs-2 node web/src/app/verify-agents.mjs
LIGHTMONI_QA_RUN=tabs-3 node web/src/app/verify-agents.mjs
LIGHTMONI_QA_RUN=1 node web/src/features/dashboards/verify-alert-navigation.mjs
LIGHTMONI_QA_RUN=2 node web/src/features/dashboards/verify-alert-navigation.mjs
LIGHTMONI_QA_RUN=3 node web/src/features/dashboards/verify-alert-navigation.mjs
```
