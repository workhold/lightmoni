# SDD 025：实施计划与导航契约

1. 基于 GitHub 最新 `main` 建立功能分支，盘点现有导航与路由权限。
2. 在独立导航模块中定义五组入口，统一每个入口的双语标签、图标、路径和 `adminOnly` 属性；由同一定义派生扁平入口供标题与上下文查找。
3. 渲染带可访问组名的导航分区，保留每个 Link 的路径、双语提示和现有 active 判断，补 `aria-current`。成员过滤在渲染前完成并去掉空组。
4. 单独样式文件维护组标题、组内间距、折叠分隔、焦点反馈和滚动，复用现有主题变量及 shell 展开/收起状态。
5. 构建与浏览器验收，更新任务和验证记录，提交 GitHub PR。

## 契约

- 入口路径仍为 `/`、`/assistant`、`/dashboards`、`/logs`、`/alerts`、`/machines`、`/agents`、`/services`、`/data`、`/data-management`、`/settings`、`/admin`，每项恰好出现一次。
- `adminOnly`：仅 `/machines`、`/services`、`/admin` 为真，与当前受保护路由一致。
- 分组只是展示结构，不使用虚构路由，不改变 `page.path`、中文 `page.title` 和双语顶部标题的含义。
- 展开时标题可见，收起时标题在视觉上隐藏但保留组名语义；各图标链接保持可键盘聚焦。
- 不引入新的偏好存储项；继续使用 `lightmoni.nav.collapsed`。
