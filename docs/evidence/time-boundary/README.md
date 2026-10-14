# 聚合时间桶边界与默认间隔

2026-10-14。查询范围未对齐桶边界时，`$__timeInterval` 返回的首个桶起点可能早于 `range.from`。图表固定时间轴范围后，未裁剪的曲线会伸进纵轴标签区。G2 5.4.8 的 `chart.options` 将单个 mark 包装为 view 时不会把 `clip` 提升到 view，因此修复显式使用 view 并在绘图区设置裁剪。原始时间桶、数值、图例统计与提示信息保留。

新面板和未配置聚合间隔的已有面板默认固定 `1min`。编辑器与查询检查器使用同一默认值；显式配置的 `auto` 或其他固定间隔保留。

浏览器验证使用确定的 API 数据夹具和真实 Dashboard / PanelEditor / G2 Canvas，不写入数据库。范围为北京时间 07:05–08:05，`1h` 聚合返回 07:00 和 08:00 两个桶，复现曲线越过左边界并检查实际绘图区的裁剪路径。另验证默认查询为 60,000ms、编辑器固定间隔状态、390px，以及面积、时间柱状、热力和状态时间线的裁剪。

- [修复前](before.png) / [1h 修复后](hourly.png)
- [默认 1min · 390px](minute-390.png)
- [浏览器报告](report.json)

从 web 目录启动 `npm run dev -- --config src/features/dashboards/qa-vite.config.mjs --port 5178 --strictPort`，再运行 `node src/features/dashboards/verify-time-boundary.mjs`。夹具拦截所有 API 请求，无需运行后端。
