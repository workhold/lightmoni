# Discover 工作台改造与实际验收

2026-10-10，使用当前 Docker 主服务 `http://localhost:18380`，本机 Agent `14318`，真实 HTTP → Node SDK → Agent → ClickHouse 业务流量。开发页 `5173` 仍代理旧实例，不能用该入口判断新主服务的结果。

参考 [Elastic Discover 的字段探索、筛选和文档下钻](https://www.elastic.co/docs/explore-analyze/discover/discover-get-started) 与 [字段统计](https://www.elastic.co/docs/explore-analyze/discover/show-field-statistics)。沿用项目的密集白底工作台与共享 AntD 控件，未新增全局样式或另做风格卡片。选定流程是查询 → 时间/维度聚合 → 点击值筛选 → 原始日志 → 保存重读。

原页面的实际缺陷：检索控制区和空图占据首屏；没有可选时间桶；字段 Top 值仅来自已载入的行；字段表达式不可输入；聚合分析与日志明细缺乏直接联动。现在查询栏支持字面正文词以及 `service:api level:ERROR @status>=500` 等小型字段表达式，执行后成为可编辑 chips；SQL 在页面内编辑。字段统计和 service/level 聚合由真实查询服务计算完整选定范围，点击值直接形成类型化筛选，返回原始日志。

| 实际操作 | 可观察结果 |
| --- | --- |
| 默认最近一小时 | 740 条匹配；service 聚合 checkout 247 / order 247 / inventory 246；列表先载入 200 条 |
| 点击 checkout 聚合 | 返回 248 条。独立查询间一条晚入记录变为可见，保持独立聚合语义，未声称事务快照 |
| 按 level 聚合 | INFO 196 / WARN 33 / ERROR 19 |
| 点击 ERROR | 19 条原始日志，正文 `Payment upstream timed out`，service/level chips 可见 |
| 打开原始事件 | event_time、ingested_at、source_id/source_seq、trace_id/span_id 可见；结构字段 status=500、route=/api/payments、payment_method=alipay 等为真实记录 |
| 字段搜索 status | Top 值显示数字 500 / 19，匹配与字段存在数均为 19；聚合分析进入主工作台，点击值添加数字筛选并返回原始日志 |
| 手选一分钟时间桶 | UTC 分钟边界 01:13 / 01:14 / 01:15 / 01:16，计数 6+5+5+3=19 |
| 实际鼠标拖选 | 范围缩至 01:05:56.549–01:16:21.549Z，返回 18 条；浏览器 Back 恢复原范围及 19 条 |
| 保存、更新、列表重开 | 同一保存 ID `13791cef1c6a9174c955f1a3544bfd0e`，保留 service/level/status、绝对范围、时间桶及聚合维度 |
| 连续三次刷新 | 第 1、2、3 次均重新读取并恢复 19 条、数字 status chip、一分钟桶和保存名称 |
| 751×914 视口 | 字段可收起，时间图、聚合和多条带服务/级别的日志正文处于首屏 |

后端 `go test -race ./internal/logs` 连同真实 ClickHouse 通过，覆盖聚合 total/present、缺失值、UInt64 Top 值精度、字段/属性参数注入和时间桶上限。前端 8 项数据/表达式测试通过；全前端 TypeScript 检查通过。完整打包和 Docker 更新由主干统一执行。

截图：`workbench-750.jpg` 为保存重读后的真实工作台，`detail-750.jpg` 为真实事件的属性下钻。已查看实际截图；采用自检，未进行独立视觉评审。chip 插入、聚合条宽变化与共享详情抽屉使用短过渡，减少动态效果的系统设置会关闭自定义过渡；本轮未另录制动效。

首版保留明确边界：小型字段表达式不承诺完整 KQL/Lucene；历史行结果依旧是 2 分钟、2,000 行/8 MiB 的有界冻结会话；统计是独立范围查询。复杂聚合 SQL 可在大盘图表中配置，日志 SQL 模式要求保留原始日志字段以支持事件下钻。

独立交互审阅发现初版“聚合”在结果区上方展开，却将结果区日志表隐藏，只剩工具栏/会话提示。该版本未通过验收。已修为同一结果区的原始日志/聚合两个 ARIA tab：完整聚合配置、范围说明和 Top10 都在聚合 tabpanel 内，切换后滚入视口；聚合模式没有冻结会话/日志末尾语义；顶部紧凑摘要保留范围说明并提供“查看更多”。短范围 X 轴显示时分秒。`examples/logs/interactions.mjs` 增加同区聚合/非空结果/返回原始日志回归断言。最终 Docker 验证和独立复核记录将在通过后补充。

修正后的本地工作台 `15174` 使用真实 `18380` API（没有模拟响应），完成三轮聚合 → 数字 500 下钻 → 原始日志 → 刷新，每轮均保留 19 条、保存名称与三枚过滤 chips。方向键左右切换时焦点留在目标 tab。窄屏“查看更多”进入同一结果区，Top10 与完整查询范围可见，聚合模式没有日志会话 footer。一分钟绝对范围 09:16:00–09:17:00 查询得到 6 条，水平坐标显示 09:16:00/15/30/45/09:17:00。已实际查看 `qa-aggregation-750.jpg`、`qa-aggregation-1440.jpg`、`qa-short-axis-750.jpg`。QA 代理仅用于当前源与真实 API 的联调，不代表生产 Origin/CSRF 验收。增加的 Playwright 聚合/焦点断言尚未重新运行；以上新布局证明来自实际 CUA 操作。

尾部部分时间桶另有真实鼠标边界验证：绝对范围 `01:16:00.000–01:16:33.454Z` 为 3 条，点击时间柱后结束时间仍为 `01:16:33.454Z`、日志仍为 3 条，未扩大至整分钟而带入额外事件；与键盘分布数据入口一致。原三项阻断修复已由 `docs/evidence/interaction-review/recheck-report.md` 独立确认；最终水平刻度、模式切换焦点及部分桶边界仍需统一运行版部署核对。

主干确认本轮日志源码冻结并验收完成，最后水平刻度、结果模式焦点和部分桶边界补丁随 Leafer 新画布统一部署；不将这三项的源页面验证冒充已部署验证。独立 15174 QA 已停止，临时 Tab 已关闭，viewport 覆盖已 reset。后续统一运行版的最终核对由主干安排。
