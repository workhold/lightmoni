# 2026-10-11 工作台验收

本目录的截图、参考图和录屏仅保存在本机 [`artifacts/screenshots/docs/evidence/workbench-next/`](../../../artifacts/screenshots/docs/evidence/workbench-next/)，由 Git 忽略；下文未带路径的图片和录像文件名均相对此目录。文字报告继续保留在仓库中。

运行环境：真实本机 Agent → localhost:18380 Go 服务 → Docker ClickHouse。localhost:5174 是同后端的浏览器验收前端。没有使用随机曲线或伪造告警事件。

| 范围 | 结果与证据 |
| --- | --- |
| 全站主题 | 默认深色；设置切换浅色，重载仍回显浅色，再切回深色。settings-dark / theme-light / dashboard-light 及 overview、agents、data、assistant、query、alerts-center 截图。 |
| 顶部与直接布局 | 删除保存成功横幅、拖动说明和大盘编辑按钮，时间刷新与添加可视化同组。拖拽/缩放后才显示保存，三轮成功记录见 three-rounds.json。 |
| 并发版本 | 普通保存冲突显示服务器版本；确认覆盖期间再变更仍冲突，第二次确认后成功。version-conflict.jpg，历史保留所有快照。 |
| SQL 和图例 | 查询 A/B 连续行，独立参数/启用/复制/删除，不预先绑定 table；右侧统计含 Last*、Avg、Max，可配置宽度，小面板转底部。sql-rows-right-legend.jpg。 |
| 刷新稳定性 | refresh-stability.json 记录同一 G2 实例连续 51 → 143 → 151 次更新，边界尺寸完全不变。 |
| 指标告警 | 从 CPU 面板实际查询创建规则，真实预览成功，实际触发及自然恢复事件见 alert-events.json、alerts-dashboard.jpg。红色阈值、触发/恢复时间线与点标记使用原值。 |
| SQL / 日志告警 | 自定义 SQL 预览统计 485 条；ERROR/FATAL 日志条件分别匹配 Go/Node 服务 49/48 条。sql-alert-preview / log-alert-preview 截图。两条验收规则保存为暂停，集中列表可见。 |
| Trace | 详情“按 Trace 筛选日志”保留来源和绝对范围，匹配 1 条；logs-trace-filter.jpg。独立页面和专用接口暂移除。 |
| 窄屏 | 390px 面板纵向排列，页面无横向溢出，桌面布局未修改；dashboard-390、editor-390 截图。 |
| 采集 | 按用户授权只给 local-agent-acceptance 开放 host、agent、probe；积压队列归零，本机最新心跳在线。未更换 Key 或放宽其他范围。 |

前端构建/类型检查通过，38 条模型与格式化测试通过。后端 dashboards、alerts、server 的 race 检查通过，包含窗口事件筛选、截断、强制覆盖版本约束和 Agent 分组路由注册冲突回归。最新服务健康检查已通过，入口 HTML 与 JS 资产均逐字节匹配最新本地构建；实际浏览器最终页已核验。

服务未上线，本轮采用统一的新数据契约，不添加旧单位、旧 Trace 路由、告警类型缺省或版本/Agent 历史迁移兼容分支。本地验收数据已一次性更新为当前格式。

截图静态评审另见 independent-review.md。没有完整独立动效录屏，不声明动效全项通过。


新增图表仅选择可视化类型，查询起点与 table 下拉都已移除；SQL 编辑行也不再要求表选择。新查询为空时提示编写 SQL 后运行，点击运行检查空查询；不会用占位数值冒充业务结果。multiple-table-sql.json 是保存后回读：A 来自 metric_host_gauge，B 来自 metric_agent_gauge，两条查询实际运行并保存到验收副本 v9。add-visualization / add-visualization-390 / multiple-table-sql 截图记录本轮流程。

静态评审的 P2 后续处理：告警标记文字加大并提高深浅主题对比度；规则显式存储展示单位，告警中心四舍五入至两位并保留原值提示；390px 时间与添加的顶部坐标均为 63px；助手按钮移到导航空白区；助手卡片与输入区保留独立高度。截图已更新。
