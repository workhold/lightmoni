# 日志搜索：Discover 对齐

日期：2026-10-16。目标是让日志排查沿用 Kibana Discover 的布局与操作习惯；保留 LightMoni 导航、数据目录、真实日志 API 和检索边界。

参考：[Elastic Discover 文档](https://www.elastic.co/docs/explore-analyze/discover/discover-get-started)、[官方文档表格截图](https://www.elastic.co/docs/explore-analyze/images/kibana-document-table.png)。主参考为桌面 Discover 的查询行、字段侧栏、时间分布与文档表格；390px 窄屏为适应现有应用的延展。没有额外探索风格。

## 设计与操作

- 取消查询与工作区的独立卡片外框，以连续分隔线组织数据视图、搜索、时间、过滤、字段与结果；统一蓝色操作、灰色字段栏和表格条纹，兼容深浅主题。
- 查询框内切换正文、字段表达式与 SQL；切换数据视图立即查询并解除旧保存检索关联。自动刷新设置移入时间面板，服务与 Trace ID 放入快捷筛选弹层。
- 时间面板提供常用范围、自定义相对时长、绝对时间、自动刷新，以及前后时间段平移。时间图支持总量与按级别拆分，长范围横轴显示日期，保留点击时间桶和框选能力。
- 字段侧栏提供类型筛选、多词搜索、分组折叠、Top 值弹层、加减列、调整顺序和拖入表格。Top 值仍请求当前查询的完整范围。
- 文档表格提供表头排序与列菜单、单元格包含/排除/复制、行高、密度、全屏与 Esc 退出；表格占满可用宽度，各列仍一起横向滚动。窄列使用菜单以免遮挡原有的值筛选入口。
- 详情默认显示字段表格，支持搜索字段和值、仅看已选字段、增减列和包含/排除筛选；保留 JSON、原文、上下文、Trace 关联和 AI 分析入口。

主动作是执行查询。删除了重复的详情摘要、常驻服务和 Trace 输入、单独的行高控件、重复的匹配/加载与限制说明；过滤条件、有效期及上限仍有明确入口。检索名称、当前数据视图和失败后的输入不省略。

## 验证与证据

执行入口为 `web/src/features/logs/verify-discover.mjs`、`verify-columns.mjs` 与 `verify-performance.mjs`。交互验证使用本地开发页面与真实 Docker API；只有保存失败、保存检索只读回放、查询失败和超长表名使用拦截响应，未向真实实例写入或删除保存检索。性能回归使用原有的 2,000 条控制响应，不代表真实后端性能基准。

截图与录像保存在被 Git 忽略的 `artifacts/screenshots/docs/evidence/log-discover/`，报告保存在本目录。覆盖桌面 1440×1000、750px、390px，以及 720 CSS px / 1440 输出像素的 200% 等效布局。浮层截图先验证目标状态，再等待有限动画结束，避免将入场帧当成稳定画面。

交互录像覆盖首次进入、查询的 loading 反馈、字段和时间弹层切换。系统减少动态效果设置会关闭自定义入场和过渡。独立静态评审不替代交互脚本或动效验证。

## 独立静态评审

首轮结论：桌面层级与深浅主题成立，不打分。发现部分截图处于浮层/抽屉的中间帧，要求补拍稳定状态；建议明确总命中/已载入/上限的区别，增大辅助文字。已增加稳定状态等待，明确页脚数量，合并重复限制提示，提高时间刻度、会话提示与字段说明字号。复核结果见 `review.md`。

## 范围边界

这是已有 LightMoni 日志页的前端操作与视觉对齐。字段表达式继续使用现有解析能力，复杂查询继续用 SQL；没有新增 Elasticsearch、完整 KQL/Lucene、ES|QL、跨文档比较或日志模式聚类。查询结果继续受两分钟冻结会话、2,000 条 / 8 MiB 限制；总命中来自独立时间分布聚合，表格数量表示当前已载入文档。

本轮不运行生产构建或部署。其他页面的样式改动不属于本次日志任务。

## 最终结果

| 检查 | 第 1 轮 | 第 2 轮 | 第 3 轮 |
| --- | --- | --- | --- |
| Discover 真实交互与失败恢复（13 项） | 通过 | 通过 | 通过 |
| 列宽/顺序/横向滚动/窄屏回归（6 项） | 通过 | 通过 | 通过 |
| 2,000 条控制数据回归 | 通过 | 通过 | 通过 |

`npm --prefix web run typecheck` 与 `git diff --check` 通过。项目未配置独立 lint 脚本。三轮性能检查中，输入关键词及搜索字段均未重复解析属性或重绘时间单元格；运行时长受并行浏览器负载影响，不据此作与 Kibana 的性能对比。完整汇总见 [verification.json](verification.json)。

关键画面：`1-desktop-light.png`、`1-desktop-dark.png`、`1-time-panel.png`、`1-absolute-time-panel.png`、`1-dark-document.png`、`1-mobile.png`、`1-mobile-fields.png`、`1-zoom-200.png`，均位于 `artifacts/screenshots/docs/evidence/log-discover/`。

三段 4 秒动效证据为 `entry.mp4`（首次内容出现）、`query-feedback.mp4`（时间查询与 loading 反馈）和 `panel-switch.mp4`（显示设置与详情切换）；同目录保留 `*-frames.png` 和三轮 `*-interactions.webm`。主 Agent 已查看四帧联系图，独立评审仅对稳定静态截图负责。
