# 大盘时间聚合

2026-10-11。面板编辑器的「查询选项」支持固定时间桶（30s、1min、5min 等及自定义间隔）、自动间隔、最小间隔和最大数据点。配置保存在面板 options 中，间隔通过已有 `interval_ms` 查询契约传给 ClickHouse 的 `$__timeInterval(时间字段)` 宏。

2026-10-14 更新：新面板和未配置间隔的已有面板默认固定 `1min`；显式选择 `auto` 后才按范围和宽度调整。非对齐范围首个时间桶早于查询起点时，图形裁剪到绘图区，详见[时间桶边界验证](../time-boundary/README.md)。

自动模式使用项目已有 `@grafana/data` 的间隔舍入规则，以时间跨度和实际面板像素宽度计算粒度；填写最大数据点后使用固定分辨率。最小间隔只约束自动模式，固定模式使用明确指定的桶宽。全屏查看使用全屏宽度，返回后恢复网格宽度；布局拖动期间不发起宽度变化导致的查询。

每条查询可切换 avg、max、min、sum、count、p50、p90、p95、p99。普通单聚合 SQL 保留参数、筛选、序列分组和聚合外的单位换算，分位数改为 `quantileExact(level)(原始样本表达式)`。加权公式、子查询、多聚合、窗口查询、count() / count(*) 等保留 SQL 编辑入口；时间间隔不会替未使用分桶宏的 SQL 添加分组。

编辑查询选项后需要运行查询，预览保留上次执行的查询和间隔；切换原始数据视图保留同一粒度。检查器显示实际桶宽。保存接口验证间隔格式、上限和最大数据点。

官方参考：[Grafana Query options](https://grafana.com/docs/grafana/latest/visualizations/panels-visualizations/query-transform-data/#query-options)、[ClickHouse quantileExact](https://clickhouse.com/docs/reference/functions/aggregate-functions/quantileExact)。

## 验证

- TypeScript 检查和前端生产构建通过（构建到临时目录，未替换服务端静态资源）。
- 前端模型、聚合、图表刷新和图表告警共 38 个测试通过。
- `go test ./internal/dashboards ./internal/query` 通过，包括查询选项校验、创建、更新、复制和 SQLite 重启后的读回。
- [真实浏览器报告](report.json)：714 条 CPU 原始样本，1min avg、5min p95 / max 与独立计算一致，UTC 时间桶对齐；验证待运行状态、原始数据视图、自动与固定间隔、390px、保存刷新以及全屏分辨率变化。临时测试大盘已删除。
- 已查看[桌面截图](editor-desktop.png)和 [390px 截图](editor-390.png)。

复跑浏览器验证：从 web 目录启动 `npm run dev -- --config src/features/dashboards/qa-vite.config.mjs --port 5178 --strictPort`，再运行 `node src/features/dashboards/verify-aggregation.mjs`。默认使用现有本机 Docker API 和验收账号，可通过脚本的环境变量覆盖地址与账号。
