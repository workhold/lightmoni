# 大盘交互与深色主题验收

2026-10-10 完成 Grafana 风格工具栏、时间选择、创建、查看、编辑、布局和保存流程；2026-10-11 按用户新要求改为深色，并移除新增的 As table。

## 验证

- 模型、网格布局、Grafana 单位转换和计算：22 个测试通过。
- TypeScript 检查与生产前端构建通过。
- 使用 Docker API 和本机 Agent 真实数据；原有大盘数据保留。测试副本 `fd94d11f-17c7-4bf2-ad30-66e25269b5e8` 用于重复保存验证。
- 三轮拖拽、方向键缩放、类型切换、保存、刷新与时间恢复记录：[three-rounds.json](three-rounds.json)。
- 深色版本重新验证创建、查看到编辑、时间选择、单位选择、自定义后缀、统计和颜色保存回读。业务序列 Avg 为 155.85 次，Max 为 166/167 次，分别计算；订单服务橙色 #ff9830 和别名保存后回显。
- 窄屏 390×844 验证编辑器、设置抽屉、时间选择器和添加图表弹窗，最后一种状态图可通过滚动选择。

## 深色截图

- [主机大盘桌面](dark-dashboard-desktop.jpg)
- [图表全屏查看](dark-chart-view.jpg)
- [图表编辑器](dark-chart-editor.jpg)
- [数值面板 Max 预览](dark-stat-max.jpg)
- [390px 编辑器](dark-editor-390.jpg)、[390px 设置](dark-settings-390.jpg)
- [390px 时间选择](dark-time-picker-390.jpg)
- [390px 新建可视化](dark-add-390.jpg)、[滚动后的类型选择](dark-add-390-scroll.jpg)

本轮静态截图用于视觉复查；没有完整起、中、止三帧或录屏的动效不标为独立验收通过。
