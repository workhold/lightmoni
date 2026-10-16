# Grafana 大盘交互对齐与验收

本目录的截图、参考图和录屏仅保存在本机 [`artifacts/screenshots/docs/evidence/grafana-parity/`](../../../artifacts/screenshots/docs/evidence/grafana-parity/)，由 Git 忽略；下文未带路径的图片和录像文件名均相对此目录。文字报告继续保留在仓库中。

2026-10-15 至 2026-10-16。参考 [Grafana 官方演示大盘](https://play.grafana.org/d/000000016/time-series-graphs) 和 [官方操作说明](https://grafana.com/docs/grafana/latest/visualizations/dashboards/use-dashboards/)，实际查看默认/编辑模式、时间选择、图例和图表。使用现有开发服务与隔离验收浏览器，没有另外部署 Grafana。

方向：保留 LightMoni 的导航、品牌、深浅色设计变量和 SQL 数据模型，优先对齐每天看图、查数、调整时间和编辑大盘的操作习惯。监控数据是首屏主角，减少持续占位的编辑控件与重复文字。

## 已落地

| 入口 | 当前行为 |
| --- | --- |
| 打开大盘 | 默认查看；通过“编辑”进入布局编辑；新建和恢复草稿保持可编辑 |
| 保存/退出 | 保存后回到查看；失败保留输入；刷新恢复的草稿也能正确放弃并恢复服务端定义 |
| 面板 | 标题/右上角菜单、全屏查看、编辑、数据检查；鼠标所在面板按 E 编辑、V 查看、Esc 返回 |
| 图例 | 单击隔离该序列，再点恢复；Ctrl/Cmd/Shift + 单击增减单条，颜色设置保持可用 |
| 时间 | 半个窗口向前/向后移动、2× 扩大、拖选后同步全局/URL、双击图表扩大；新增整日/周/月/年范围、`13h` 快选和最近使用 |
| 刷新 | 保留上次完整画面，显示细进度条；失败明确标识过期结果；修复已存 10 秒间隔显示为裸数字的问题 |
| 时序图 | 非堆叠时间折线/面积使用 uPlot，同步十字线和共享提示；数据、范围及图例更新沿用原实例 |
| 编辑器 | 预览时间可独立选择/拖选，预览高度可拖动或按方向键调整；查询选项默认折叠，预览与 SQL 同屏；增加平滑/阶梯插值和线宽 |
| 窄屏 | 修复时间工具栏横向溢出及刷新图标隐藏，并允许角落时间弹层水平移位以保持在视口内；告警事件说明移到图底部，阈值使用简短数值；保留事件提示 |

uPlot 的使用方式参考 [Grafana 的 Plot 实现](https://github.com/grafana/grafana/blob/main/packages/grafana-ui/src/components/uPlot/Plot.tsx) 和 [uPlot 官方仓库](https://github.com/leeoniya/uPlot)。继续使用既有轴范围、单位、空值、阈值和告警数据契约。重复时间点、类别轴、堆叠及柱图/其他特殊图表继续使用 G2，保留原有绘图语义；这部分没有整体切换渲染器。

本次没有新增 Grafana 的插件生态、文件夹/页签/行分组、云端分享等平台功能。

## 验证方式

- TypeScript 检查通过；相关模型、布局、单位、刷新队列、时间语法、图例/序列对齐和告警计算共 **52 项测试通过**，输出在 [unit-tests.txt](unit-tests.txt)。
- 主 Agent 连续运行三轮 [verify-grafana-parity.mjs](../../../web/src/features/dashboards/verify-grafana-parity.mjs)。每轮使用独立临时大盘，覆盖查看/编辑、图例、悬停、刷新、503 恢复、拖选、双击、全屏与 Esc、布局保存读回、面板设置保存、草稿恢复后放弃、窄屏、浅色和减少动态效果；每轮连续三次往返 751/390px 并打开、关闭时间弹层。
- 大盘定义真实读写 SQLite；ClickHouse 执行 SQL 生成约 15,000 个验收观测点，包含空值、多序列、独立左右轴、柱图和堆叠面积。曲线是测试生成信号，不是业务运行指标；告警标记、接口延迟和 503 为受控测试条件。结束后删除本轮临时大盘，原有大盘不修改。
- 200% 使用等效的 **720×500 CSS 视口、2× 像素密度**，截图为 1440×1000，并检查 Canvas 像素宽度与显示宽度的比例；避免用 CSS zoom 放大低分辨率画布来误判真实浏览器缩放。
- 悬停期间统计浏览器 `requestAnimationFrame` 的间隔，并检查 SQL 数量、绘图提交计数、Canvas 实例是否变化。该数据不是端到端输入延迟或所有设备的帧率承诺；各轮实测值保存在 JSON 报告。

逐轮结果和采样：[1-report.json](1-report.json)、[2-report.json](2-report.json)、[3-report.json](3-report.json)。

| 轮次 | 结果 | 悬停采样数 | P50 / ms | P95 / ms | 最大间隔 / ms |
| --- | --- | --- | --- | --- | --- |
| 1 | 通过，控制台异常 0 | 83 | 16.7 | 16.8 | 16.8 |
| 2 | 通过，控制台异常 0 | 83 | 16.7 | 16.7 | 16.8 |
| 3 | 通过，控制台异常 0 | 83 | 16.7 | 16.7 | 16.8 |

复现：在当前开发环境运行 `LIGHTMONI_UI_URL=http://127.0.0.1:5174 LIGHTMONI_QA_RUN=1 node web/src/features/dashboards/verify-grafana-parity.mjs`。5174 为仓库已有 QA Vite 配置，API 使用本机 Docker 验收实例；验收脚本转发开发请求时使用该实例配置的 Origin，不更改服务端安全配置。

## 视觉与动效证据

- 基线：[before.png](../../../artifacts/screenshots/docs/evidence/grafana-parity/before.png)；参考：[grafana-reference.png](../../../artifacts/screenshots/docs/evidence/grafana-parity/grafana-reference.png)、[grafana-edit.png](../../../artifacts/screenshots/docs/evidence/grafana-parity/grafana-edit.png)。
- 桌面：[1-dashboard.png](../../../artifacts/screenshots/docs/evidence/grafana-parity/1-dashboard.png)、[1-shared-tooltip.png](../../../artifacts/screenshots/docs/evidence/grafana-parity/1-shared-tooltip.png)、[1-edit-mode.png](../../../artifacts/screenshots/docs/evidence/grafana-parity/1-edit-mode.png)、[1-panel-editor.png](../../../artifacts/screenshots/docs/evidence/grafana-parity/1-panel-editor.png)、[1-fullscreen.png](../../../artifacts/screenshots/docs/evidence/grafana-parity/1-fullscreen.png)。
- 窄屏：[1-dashboard-390.png](../../../artifacts/screenshots/docs/evidence/grafana-parity/1-dashboard-390.png)、[1-time-390.png](../../../artifacts/screenshots/docs/evidence/grafana-parity/1-time-390.png)、[1-dashboard-751.png](../../../artifacts/screenshots/docs/evidence/grafana-parity/1-dashboard-751.png)、[1-time-751.png](../../../artifacts/screenshots/docs/evidence/grafana-parity/1-time-751.png)。
- 主题/放大：[1-light.png](../../../artifacts/screenshots/docs/evidence/grafana-parity/1-light.png)、[1-200-percent.png](../../../artifacts/screenshots/docs/evidence/grafana-parity/1-200-percent.png)。浅色和放大图展示的是拖动并保存后的布局，顶部留白属于该布局，不是主题差异。
- 完整操作录屏：[interactions.webm](../../../artifacts/screenshots/docs/evidence/grafana-parity/interactions.webm)。主操作反馈为按钮按下/刷新细进度条，状态切换为时间弹层与全屏抽屉，首次进入为布局一次 160ms 淡入；数据刷新不重播出场。对应片段：[entry.mp4](../../../artifacts/screenshots/docs/evidence/grafana-parity/entry.mp4)、[refresh-and-brush.mp4](../../../artifacts/screenshots/docs/evidence/grafana-parity/refresh-and-brush.mp4)、[panel-transition.mp4](../../../artifacts/screenshots/docs/evidence/grafana-parity/panel-transition.mp4)。减少动态效果时关闭出场/位移和循环进度动效，保留状态提示。

独立评审按存量润色执行，不打分。发现的孤立蓝点、移动刷新按钮空白、选项截断、编辑器 SQL 区被查询选项挤压和窄屏标注位置已修正；蓝点是零尺寸选框的边框，已改为内阴影。评审者查看了截图和录屏抽帧，未独立验证连续播放的速度、缓动与跟手程度。主 Agent 完成实际浏览器流程和帧间隔测量。

删减：移除常驻的逐面板“编辑”按钮、版本号、指标卡重复标题/观测点说明，以及时序图重复的阈值/双轴脚注；图例、查询、单位、阈值和原始数据仍可查询。折叠查询选项中的说明，保留展开入口。
