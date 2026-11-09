# US1 遥测与原生监控验收

日期：2026-11-09（Asia/Shanghai）。基线 origin/main 3d67b5d；所有现场操作仅使用新建的本机隔离中心与可丢弃 ClickHouse 容器，未连接生产主机、安装 Agent、发布或部署。

## 实现与兼容

- Go、Node、Python、Rust、Java、.NET、PHP、Ruby 后端 SDK 默认把本机 hostname 写入 OTLP resource `host.name`，部署变量 `LIGHTMONI_MACHINE_NAME` 覆盖默认值，显式 resource 优先。Node 浏览器入口保持无 OS 依赖。Agent 的平台身份覆盖与冻结批次重试逻辑保留。
- Agent 心跳上报既有 `cpu_count`（逻辑核）和 `memory_total_mb`（MiB）；未知硬件不伪造为零。服务端验证正整数/正有限值，错误报告原子拒绝，旧 Agent 缺字段仍兼容。主机 summary 新增 `capacity`，仅属于当前有效 Agent，带服务端观测时间与过期标记；移除/替换不回退旧 Agent 数据。既有调度读取这两个字段，无需新建另一种容量模型。
- 主机采集增加 `host.cpu.logical_count`，保留已有 `host.memory.total`。主机列表显示容量与监控按钮；`/machines/:id/monitoring` 复用现有 PanelCard/查询 API，参数化 machine/Agent 归属，禁止空 Agent 范围匹配，容量每 15 秒刷新；各内存序列单独绘制。
- `/system/monitoring` 与系统菜单提供中心、执行节点和 SDK 的原生只读监控；应用/网站原有独立监控继续复用。`/api/v1/system-monitoring` 返回现存种子定义；用户 `/dashboards` 目录过滤内容仍等同种子的内置项。历史自定义定义、用户复制、版本、深链与删除意图保留，无数据删除或重建。
- 最新主干指标命名已经规范：业务 `metric_<logical>_<sum|gauge|histogram>`，系统 `lightmoni_metric_*`；业务 histogram 的裸逻辑视图是兼容别名。本次补契约注释与回归测试，未发现需重命名的实际不一致，不改物理表和旧 SQL。

## 已通过

- `npm test --prefix sdk/typescript`：28 项，含 Node 三信号 hostname 与浏览器隔离。
- `go test ./sdk/go`：通过，含 OS 默认、部署变量与显式覆盖。
- `python3 -m unittest discover -s tests`（sdk/python）：36 项。
- `python3 scripts/test-sdks.py --docker --cases fixture,trace_scope`：六语言（Python/Ruby/Java/.NET/PHP/Rust）12 组真实 HTTP 协议/关联验证通过，并逐资源验证非空 hostname。Rust 容器构建成功，另以同一编译器与已编译依赖执行源码 unit 6 项（包括 hostname 默认/显式优先）通过。见 [SDK 报告](sdk-conformance.json)。
- Runtime 相关基础 57 项通过；新增/补充容量、CPU 与身份专项后，32 项（agent、agent-collect、task-center-model、telemetry-followups）通过。覆盖旧 Agent、非法容量整批拒绝、当前 Agent 身份、新鲜度、移除及命名前缀。
- `node --test web/src/features/logs/model.test.mjs web/src/features/dashboards/*.test.mjs`：69 项通过。
- web/runtime TypeScript 检查通过。
- `verify-performance.mjs`：2,000 行约 2.51 MB、40 个后出现字段，真实浏览器虚拟滚动与缓存检查通过；初次加载 3,788 ms，关键词阶段零额外属性解析、零时间单元格重绘、零 long task；字段搜索 25 ms。加载过程中最长 long task 185 ms，此结果不证明任意数据量或机器负载下都无卡顿。见 [日志性能报告](log-performance/optimized-report.json)。
- `verify-grafana-parity.mjs`：12 组交互通过，真实 SQLite/ClickHouse，悬停 p95 16.8 ms；含布局持久化、图例、刷新、错误恢复、预览、草稿、390px 和 200%。见 [Grafana 报告](grafana-parity/117-report.json)。
- `verify-deep-parity.mjs`：15 组通过，含变量 URL/历史、分组、复制、全部现有可视化、分享、独立预览和 SQL 编辑。见 [深度交互报告](grafana-deep-parity/117-report.json)。
- `verify-native-monitoring.mjs`：本机 SQLite 容量夹具 → 真实 HTTP 投影、SDK → ClickHouse → 三张主机曲线、系统只读目录与 390px 英文页面通过，零页面异常。夹具不执行 SSH。见 [原生监控报告](native-monitoring/report.json)。截图保存在忽略的 `artifacts/screenshots/specs/117-deployment-followups/evidence/`。

## 复现参数与实际限制

隔离服务端口为 18717（中心）、18718（新 ClickHouse）、5177（前端）。Grafana 脚本新增 `LIGHTMONI_QA_ORIGIN` 参数，以匹配中心配置的外部 origin；首轮发现的是 QA 请求的 origin 不一致，未放宽产品 CSRF。日志性能脚本新增 `LIGHTMONI_QA_OUTPUT`，避免覆盖历史证据。

Rust 的首次容器构建获取锁定依赖约 8 分钟后成功；Windows 特定 hostname 分支未在 Windows 主机运行。容量值只有升级到本次 Agent 后才由真实受管主机持续上报；本次未进行生产升级。原生主机视图最多查询 32 张 gauge 表，优先 host/lightmoni，超量有提示。

隔离中心、前端进程与 ClickHouse 容器在验收结束后关闭，tmpfs 数据随容器移除；没有修改其他已有容器或卷。

## 最终连续三轮

按 Oil UI 的交付回归要求，隔离环境下 `final-1/2/3` 每轮主机/系统监控、日志性能、Grafana parity 和 deep parity 四脚本全部通过，共 12 次。详见 [逐轮结果与前置失败](ui-three-rounds.md)。重复验收额外修正原生监控直接入口的绘图高度，以及大盘连续保存时旧目录回读锁吞掉新确认的竞态。最终性能边界以三轮报告为准：日志加载最长任务 331/197/360ms，关键词阶段分别 [96,85]/[63]/[]ms；没有宣称所有轮次都零长任务。
