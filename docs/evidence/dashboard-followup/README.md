# 菜单图标、图例排序和 URL 补充验收

本目录的截图、参考图和录屏仅保存在本机 [`artifacts/screenshots/docs/evidence/dashboard-followup/`](../../../artifacts/screenshots/docs/evidence/dashboard-followup/)，由 Git 忽略；下文未带路径的图片和录像文件名均相对此目录。文字报告继续保留在仓库中。

2026-10-16，按用户两张截图及三项反馈修正，沿用现有界面布局和图标体系；局部修改由主 Agent 自检，未安排独立视觉评审。没有新增动效或文案，排序沿用已有图例反馈，未修改并保存现有业务大盘。

- 菜单全部 8 项各有一个图标，使用统一的 Ant Design 图标：[截图](../../../artifacts/screenshots/docs/evidence/dashboard-followup/menu-icons.png)。
- 名称、Last *、Avg、Max 三态排序（升序/降序/恢复原始顺序），名称首次升序，数值首次降序。按原始数字排序，空值始终置后，保留相同值的顺序与原有颜色。
- 大盘查看为 `/dashboards/<id>`，编辑为 `?edit=true`；单图查看与编辑为 `viewPanel` / `editPanel`。退出编辑清除相应参数，时间、刷新及无关参数保留；刷新、前进/后退及旧的单图编辑链接均验证。
- 以地址栏链接、直接打开及重载验证分享状态；未断言系统剪贴板文本内容。未保存的本机草稿不会通过链接传给他人。

浏览器使用现有上报中心数据，主 Agent 连续运行同一验证流程三轮，均通过：[第 1 轮](1-report.json)、[第 2 轮](2-report.json)、[第 3 轮](3-report.json)。每轮检查菜单图标、四列表头三态排序、键盘 Enter、颜色稳定、排序不重建 Canvas/不新增绘图提交，以及大盘/单图 URL、重载和历史导航。另检查手动刷新保留当前排序，画面见 [排序截图](../../../artifacts/screenshots/docs/evidence/dashboard-followup/legend-sort.png)。

前端相关 10 项测试通过（含数字/空值排序、三态切换、原有图例显隐与 URL/分组模型测试）；TypeScript 检查和 `git diff --check` 通过。未运行生产构建及全量测试，项目未配置 lint 命令。
