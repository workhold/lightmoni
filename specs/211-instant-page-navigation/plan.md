# Plan 209：页面导航秒开与加载态

## 设计

前端 React Router 声明式路由不变，优化分三层：

1. **chunk 预取**：新增 `web/src/app/route-preload.ts`，集中管理页面懒加载 loader（与 `App.tsx` 的 `React.lazy` 共用同一 import 函数，Vite 自动去重 chunk）。提供：
   - `preloadRoute(path)`：按路由路径匹配（动态段正则优先，其次精确与前缀）loader 并触发 `import()`；
   - `schedulePreloadAllRoutes()`：`requestIdleCallback`（超时 3s，降级 `setTimeout` 1.5s）后串行预取全部页面模块；`navigator.connection.saveData` 时跳过。
   触发点：侧边栏 `<Link>` 的 `onPointerEnter` / `onFocus`；`App.tsx` 登录态 shell 渲染后调度空闲全量预取。
2. **运维数据缓存（stale-while-revalidate）**：新增 `web/src/app/ops-overview-cache.ts` 模块级缓存，`OperationsPage` 挂载时以缓存初始化 `overview` / `loading` / `overviewReady` / `statusReady`，`/ops/overview` 成功后写缓存；`load()` 现有 quiet 分支天然支持静默刷新。`App.tsx` 登出回调中清空缓存。
3. **Suspense fallback 保持**：预取后 fallback 极少出现，不改。

## 架构影响判断

不适用。纯 web 前端交互层优化：不改变组件职责划分、数据或控制路径、凭据边界、存储、协议、部署拓扑与 AI / 工具边界；`docs/system-design.md` 无需更新。

## 风险

- 空闲全量预取增加首屏后带宽（内网后台可接受；saveData 用户跳过；串行执行避免与首屏争抢）。
- 运维缓存可能短暂显示上一次数据（最多一个轮询周期），由静默刷新与 10s 轮询收敛；登出清空避免跨会话残留。
