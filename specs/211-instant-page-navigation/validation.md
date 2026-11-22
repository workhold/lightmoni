# Validation

- `npm --prefix web run typecheck` passed（基线自带的 assistant 模块解析错误经 `npm --prefix web install` 修复依赖后消失，与本变更无关）。
- `node test/instant-navigation.mjs` passed：
  - 悬浮预取后点击“应用管理”，路由与页面结构 182ms 内出现（fixture 将 `/ops/overview` 延迟 3s），先显示暂存配置视图，3s 后总览数据补齐；
  - 初始加载恰好发起 1 次 `/ops/overview`；
  - 切到“集群管理”再切回“应用管理”：无整页 Spin，缓存资源 106ms 内渲染，后台静默刷新累计 3 次请求；
  - 全程无页面错误。
- 既有回归不受影响：
  - `node test/slow-applications-load.mjs` passed（慢总览下的轮询 / 聚焦刷新、手动刷新、失败与重试语义保持）；
  - `node test/applications-status-ui.mjs` passed。
- 变更范围：`web/src/app/App.tsx`、`web/src/app/SidebarNavigation.tsx`、`web/src/app/OperationsPage.tsx`、新增 `web/src/app/route-preload.ts`、`web/src/app/ops-overview-cache.ts`；未触碰后端与 API 契约。
