# Grafana 大盘深度对齐

本目录的截图、参考图和录屏仅保存在本机 [`artifacts/screenshots/docs/evidence/grafana-deep-parity/`](../../../artifacts/screenshots/docs/evidence/grafana-deep-parity/)，由 Git 忽略；下文未带路径的图片和录像文件名均相对此目录。文字报告继续保留在仓库中。

2026-10-16。按用户追加要求，实际查看 [Grafana 官方时序大盘](https://play.grafana.org/d/000000016/time-series-graphs) 的面板编辑、完整设置和行分组，以及 [变量演示](https://play.grafana.org/d/HYaGDGIMk/templating-global-variables-and-interpolation) 的多选、插值和变量配置。结合 [URL 参数说明](https://grafana.com/docs/grafana/latest/visualizations/dashboards/build-dashboards/create-dashboard-url-variables/) 和 [变量说明](https://grafana.com/docs/grafana/latest/visualizations/dashboards/variables/) 对齐状态行为。没有另部署 Grafana，也没有向官方演示保存配置。

方向是保留 LightMoni 导航、深浅色、共享控件和 ClickHouse 类型化参数，复刻大盘的主要操作习惯。此次更新了本地验收后端以支持新增配置字段，保留原数据库；浏览器验证只创建和删除自己的临时大盘，不修改用户原有大盘。

## 对比及结果

| 项目 | 此前差异 | 当前行为与验证 |
| --- | --- | --- |
| 指标名称 | 右侧名称固定占 35%，按钮再省略，几条指标都成了 `lightmoni.ce...` | 名称完整换行，统计列固定宽度；自动估算图例宽度；给趋势区保留至少约 360px，否则转下方。额外统计列在图例内部滚动 |
| 编辑器结构 | 标题输入单独占行、常驻类型图库、设置跨多个页签、查询重复标题 | 连续的时间/刷新/应用/保存工具栏；上方预览、下方查询/告警/数据目录；右侧搜索与面板/字段/样式/图例/坐标轴/标准选项等分区；类型单独选择 |
| 可视化 | 类型切换、字段适配缺少本轮整体验证 | 连续切换现有全部 10 类：折线、面积、柱状、饼图、数值、表格、仪表、热力、分布、状态；检查渲染错误及实际 Canvas/表格/数值 |
| 编辑操作 | 预览与 SQL 空间及设置滚动不足 | 可拖动/键盘调整分隔条；独立时间、表格预览、实时显示选项；应用/保存读回；窄屏设置抽屉，低高度纵向滚动访问 SQL |
| 大盘设置 | “设置”仅打开变量抽屉 | 基本信息、描述、标签、默认时间/刷新、变量、分组、链接、只读 JSON 模型；应用至草稿后统一保存 |
| 变量 | 配置堆在一个长表单，缺少查询预览、显示/URL 控制 | 变量列表与独立编辑；自定义/查询/文本/常量，名称/标签/描述/默认值，多选/全部、隐藏、URL 开关、重排/删除；查询预览使用当前依赖值，修改的默认值参与预览 |
| URL 联动 | 联动校正后的值未完整写回，刷新与单图状态不完整 | `from/to`、重复 `var-*`、`refresh=60s/off`、`viewPanel`、`editPanel`；前进/后退、刷新还原。联动后的有效选择写回 URL，同时保留无关参数 |
| 类型化查询 | 无关变量/选项变化也可能重发查询 | 以实际绑定的 SQL/参数组成请求标识；未使用变量和无关选项变化不重发相同查询；避免选项返回顺序变化重复查询当前单选值 |
| 图表分组 | 没有分组模型 | 行分组、标题、排序、默认收起、选择/移动图表；每组独立网格；收起后停止查询；移除分组保留图表；复制图表保留所属组 |
| 持久化 | 分组等字段无法保存 | 后端验证并持久保存 rows/links/tags 和变量显示/URL 属性；复制大盘重建面板/分组 ID 并修正引用；版本冲突和历史沿用既有机制 |
| 单图查看 | 仅临时抽屉 | `?viewPanel=<id>` 可重载/历史导航/Esc 返回；`/dashboards/<id>/panels/<panelId>` 为独立页面，隐藏导航，只查询目标图表 |
| 分享与检查 | 单图缺少独立链接 | 分享携带当前时间、多选变量、刷新；登录后保留独立链接；单图检查数据/请求/性能、CSV 导出，打开/关闭检查器保留 Canvas |
| 大盘链接 | 没有集中配置 | 支持站内或 http(s) 链接，携带当前时间和变量，新标签打开；特殊字符通过 URLSearchParams 编码 |
| 日历/时间戳 | 后端默认范围只支持简单相对时间 | 支持周/月/年及整日边界；秒/毫秒时间戳可从 URL 解析，保存时规范化为 ISO 时间 |

SQL 继续使用 `{service:String}`、`{hosts:Array(String)}`，避免把界面插值文本拼入 SQL；标题支持 `$service` / `${service}`。当前只支持浏览器时区。此轮按行组织图表，尚无 Tabs 分组、跨行直接拖拽、按变量重复面板；移动图表使用菜单或分组设置。Grafana 的数据源/插件生态、Transformations/Expressions、完整 Field overrides、Annotations 编辑、时区/周起始日/Now delay 等高级设置没有伪装成可用控件，JSON 模型目前只读。G2 保留柱图、堆叠及其他特殊图形，非堆叠时序折线/面积使用 uPlot。

## 入口

- 大盘“编辑”→齿轮，或“更多大盘操作”→“大盘设置”。
- 设置页的“变量”“图表分组”“大盘链接”分别配置，应用后“保存更改”。编辑画布底部也有“添加分组”。
- 面板菜单→“移动到分组”“查看图表”“分享图表”；查看页可打开“检查图表”。
- 面板菜单→“编辑图表”，或鼠标位于面板时按 E；右侧“更改图表”和搜索设置。

## 验证

前端相关 **57 项测试通过**：[unit-tests.txt](unit-tests.txt)。后端大盘包 **11 项测试通过**：[backend-tests.txt](backend-tests.txt)，覆盖 SQLite 保存/重启读回、复制引用、非法分组、链接、日期范围以及既有版本冲突等。TypeScript 检查与 `git diff --check` 通过。没有运行生产构建或全量测试。

主 Agent 运行两组脚本：

- [深度验证脚本](../../../web/src/features/dashboards/verify-deep-parity.mjs)：长名称、全部 10 类图表、变量联动与 URL 历史、自动刷新、设置、503 保存失败重试、分组查询行为/复制/移除/取消、分享、未登录打开单图、检查器/导出、751/390px 与等效 200% 编辑器。
- [交互回归脚本](../../../web/src/features/dashboards/verify-grafana-parity.mjs)：悬停帧间隔、图例隔离/增减、同实例刷新、503 查询恢复、拖选/双击、时间菜单、单图/V/Esc、布局拖动/缩放、持久化、草稿恢复后取消、窄屏、浅色和减少动态效果。

每轮新建隔离大盘，SQLite 真实保存，ClickHouse SQL 生成验收信号；生成曲线不是业务运行指标。503、延迟和回归脚本的告警标记为受控测试条件。时间戳/变量和组引用另有纯模型及后端验证。200% 使用 720×500 CSS 视口和 2× 像素密度，检查 Canvas backing ratio。

逐轮报告：[1](1-report.json)、[2](2-report.json)、[3](3-report.json)；交互回归：[1](regression/1-report.json)、[2](regression/2-report.json)、[3](regression/3-report.json)。最终结果与帧间隔汇总见 [verification-summary.json](verification-summary.json)。悬停 rAF 间隔不是端到端输入延迟或所有设备的流畅度承诺。

最终连续三轮均通过：每轮深度验证 15 组、交互回归 12 组，浏览器错误均为 0。每轮悬停记录 83 个 rAF 间隔，P50/P95 均约 16.7ms，最大约 16.8ms；同时断言悬停不触发 SQL、绘图提交或 Canvas 重建。

## 视觉与证据

独立评审未打分；报告与修正见 [visual-review.md](visual-review.md)。评审者仅抽帧看录屏，不能确认连续动效手感。主 Agent 另检查运行/保存状态、图例/分组、入场及减少动态效果；自动化通过不等于所有设备的主观手感完全一致。

- 官方参考：[面板编辑器](../../../artifacts/screenshots/docs/evidence/grafana-deep-parity/grafana-panel-editor.png)、[变量](../../../artifacts/screenshots/docs/evidence/grafana-deep-parity/grafana-variables.png)、[变量设置](../../../artifacts/screenshots/docs/evidence/grafana-deep-parity/grafana-variable-settings.png)。
- 本地原有数据：[中心运行状态编辑器](../../../artifacts/screenshots/docs/evidence/grafana-deep-parity/actual-center-editor.png)、[完整指标图例](../../../artifacts/screenshots/docs/evidence/grafana-deep-parity/actual-center-legend.png)。
- 最终自动化截图：`1-panel-editor.png`、`1-legend.png`、`1-variable-edit.png`、`1-settings-groups.png`、`1-grouped-dashboard.png`、`1-standalone.png`、`1-preview-751.png`、`1-preview-390.png`、`1-editor-200-percent.png`。
- 动态证据：`deep-interactions.mp4` 与 `regression/interactions.mp4`；后者包含入场、图例、刷新、时间拖选及布局拖动。CSV 导出验收产物在 `inspector.csv`。

减法包括移除重复标题行、常驻类型图库、重复 ClickHouse 来源、无操作价值的禁用聚合下拉和重复 SQL 说明；对象名称、SQL、未应用状态及保存动作保留。
