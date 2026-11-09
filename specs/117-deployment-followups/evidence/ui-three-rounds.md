# US1 连续三轮浏览器验收

最终连续区间为 `final-1`、`final-2`、`final-3`，共 12 次脚本执行均 exit 0；每次脚本使用新的浏览器上下文。完整执行顺序、起止时间与标准输出见 [执行日志](ui-three-rounds-execution.json)，机器可读汇总见 [三轮汇总](ui-three-rounds-summary.json)。

| 脚本 | 第 1 轮 | 第 2 轮 | 第 3 轮 |
| --- | --- | --- | --- |
| 主机/系统原生监控 | [通过](native-monitoring/final-1-report.json) | [通过](native-monitoring/final-2-report.json) | [通过](native-monitoring/final-3-report.json) |
| 2,000 行日志性能 | [通过](log-performance/final-1-report.json) | [通过](log-performance/final-2-report.json) | [通过](log-performance/final-3-report.json) |
| Grafana 交互 | [通过](grafana-parity/final-1-report.json) | [通过](grafana-parity/final-2-report.json) | [通过](grafana-parity/final-3-report.json) |
| Grafana 深度交互 | [通过](grafana-deep-parity/final-1-report.json) | [通过](grafana-deep-parity/final-2-report.json) | [通过](grafana-deep-parity/final-3-report.json) |

## 观察与修正

- 并行夹具写 HTML 触发 Vite 页面重载，导致一次懒加载前置失败；最终使用独立依赖缓存、禁用 HMR 和 watch 的隔离 Vite。重启后缺日志表的前置条件由临时 SDK 写入建立，临时 Key 随后停用。没有放宽产品 Origin/CSRF。
- 实看 390px 截图发现，直接进入原生监控时没有 Dashboard 编辑器的绘图区布局 CSS；补局部布局并增加绘图高度大于 150px 的断言。最新曲线、百分比纵轴和内存多序列均有完整高度。
- 第一次重复验收抓到连续保存竞态：旧保存已关闭弹窗但仍持有目录回读锁，新保存确认被忽略。将目录回读移到关闭弹窗之前，保留原有快速连续保存断言，修正后连续三轮通过；深度报告还记录真实 PUT 结果。
- 这些失败保留为 `preflight-*-failure.json` 及历史执行日志，未计入最终连续三轮。
- 原生主机图例只保留最新值，移除平均/最大值的重复列，以免窄屏截断；沿用现有控件、密度和图表渲染，没有新增产品功能。局部修正由本代理看图自检，本次未另行作视觉评分。

## 性能边界

| 轮次 | 日志载入 ms | 关键词 ms | 关键词长任务 ms | 载入最长任务 ms | Grafana 悬停 p95 ms |
| --- | ---: | ---: | --- | ---: | ---: |
| final-1 | 3012 | 385.9 | [96, 85] | 331 | 16.8 |
| final-2 | 3185 | 258.2 | [63] | 197 | 16.7 |
| final-3 | 3339 | 250.2 | [] | 360 | 16.7 |

三轮关键词与字段搜索均无额外属性解析或时间单元格重绘，虚拟表格及记录/字节边界断言通过。记录到的主线程长任务如上；不能把缓存断言通过解释成任意数据量或负载下完全无卡顿。

截图在 `artifacts/screenshots/specs/117-deployment-followups/evidence/` 对应子目录的 `final-*` 文件中。

验收后已核对两个监听端口关闭、ClickHouse 容器移除，并删除本次临时状态与独立 Vite 缓存。
