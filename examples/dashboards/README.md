# 大盘运行样例

先启动真实主服务、ClickHouse、Agent，并执行 Go 与 Node SDK demo。Web 的“大盘 → 从采集数据快速开始”读取 `/api/v1/templates`，SQL 与物理表来自实时目录。页面可创建多张大盘，编辑面板查询和类型化变量后通过保存弹层保存；修改已有定义携带 revision，遇到 409 可保留草稿并另存副本。

`http-overview.json` 对应 demo 的 `metric_http_sum` 和 `log_app`。通过已登录会话将 JSON 提交到 `POST /api/v1/dashboards` 可保存；不存在这些表时先执行 demo，不要直接复制到其他表结构。UI 不依赖此文件，实时目录模板不需要预先导入。

查询时间宏是 `$__timeFilter(event_time)` 和 `$__timeInterval(event_time)`；多选服务使用 `service IN {services:Array(String)}`，在大盘变量中定义 services。窗口 Counter 为 Delta，按 `sum(value)` 汇总且过滤 temporality；累计 Counter 不能直接叠加。跨表查询可在 SQL 里使用公开表之间的 UNION / JOIN。

模块验证：

```sh
go test ./internal/dashboards
cd web
node --test src/features/dashboards/model.test.mjs
npm run typecheck
node src/features/dashboards/verify-ui.mjs
```

SQLite 测试验证复制、版本冲突、删除冲突、重新打开数据库及参数原值。前端模型测试验证共享时间、数组参数、循环依赖、注释/字符串排除和大整数精度。真实浏览器 G2、SQL、布局、保存和联动仍须在 `docs/acceptance.md` 对应操作中验证。

浏览器脚本需要真实5173开发页、18880主服务和一份已有的CPU模板大盘。可通过`LIGHTMONI_UI_URL`、`LIGHTMONI_TEST_DASHBOARD`、`LIGHTMONI_TEST_USER`、`LIGHTMONI_TEST_PASSWORD`覆盖默认隔离环境。脚本只复制原大盘，输出独立QA副本与`evidence/`证据，不修改原大盘。验证阈值/颜色的实际UI编辑、G2颜色、值映射、SQLite回读，以及八种核心图表的真实ClickHouse查询与渲染；运行后可通过revision删除本次创建的QA副本。


双 Y 轴浏览器验收（需要开发服务器连接真实 Docker ClickHouse，且本机 Agent 已采集 CPU 与内存）：

```sh
cd web
node src/features/dashboards/verify-dual-axis.mjs
```

脚本复制原 CPU 大盘，在共享 Select 中把 B 设为右轴，分别验证单位、线性/对数、独立上下界、颜色、tooltip、图例、保存/重载，以及真实 line/area/time-bar 图。保留最后 QA 副本和 `evidence/dual-axis-*.png`、`dual-axis-report.json`；不会修改原 CPU 大盘。右轴配置见 `options.right_axis_refs`、`right_unit`、`left_scale/right_scale` 和各轴 min/max，阈值仅使用左轴单位。


监控工作台交互验收（真实运行版，先由主干更新 Docker）：

```sh
cd web
LIGHTMONI_UI_URL=http://127.0.0.1:18380 LIGHTMONI_TEST_DASHBOARD=80a186bd-6b01-41b3-95c5-15ee556e735d node src/features/dashboards/verify-workbench.mjs
LIGHTMONI_UI_URL=http://127.0.0.1:18380 node src/features/dashboards/verify-sizing.mjs
```

工作台脚本复制 CPU 大盘，并加入实时目录的 SDK 请求量 SQL；实际拖动、缩放、保存、回读 API 与刷新，再验证取消还原、键盘调整、十类图表、原始数据、SQL 多色高亮和执行、面板直接保存以及 751px 全宽预览与独立设置弹层。`workbench-report.json` 记录几何尺寸、保存布局、SQL 颜色和浏览器异常。最小尺寸脚本把副本设为旧 h3 Gauge，确认自动提升到图表最小 h5、画布无裁切，方向键不能缩到非法高度，并在减少动画模式下验证保存弹层和遮罩退出；数值与表格允许 h3。两份脚本保留最终副本供复核。

隔离开发 QA 可使用 `npx vite --config src/features/dashboards/qa-vite.config.mjs`；5174 禁用 HMR，代理真实 18380 API，复用已允许的本机开发 Origin。该配置为验收工具，不进入产品 TypeScript 编译。

LeaferJS 布局验收：

```sh
cd web
LIGHTMONI_UI_URL=http://127.0.0.1:18380 node src/features/dashboards/verify-leafer.mjs
node --test src/features/dashboards/layout.test.mjs src/features/dashboards/model.test.mjs
```

布局使用 `leafer-ui` 的 [React 生命周期](https://www.leaferjs.com/ui/guide/framework/react/) 与 [指针交互桥](https://www.leaferjs.com/ui/reference/event/simulation.html)。DOM 标题/缩放手柄转交真实 pointer 给 Leafer DragEvent；React/AntV 面板保持挂载。画布只占可见窗口，绘制网格、吸附 ghost 与选框；移动只更新 DOM transform，缩放冻结图表尺寸并缩放其显示内容，标题与控件保持正常字号。放手一次提交12列整数grid到编辑草稿；现有保存弹层负责持久化revision。碰撞面板按原顺序插入下移，保留有意留出的空位；Esc撤销当前手势，取消大盘编辑恢复整轮草稿。

脚本建立独立的八面板真实CPU大盘，在1440与751视口验证碰撞、拖动、缩放、双击编辑、Esc、保存与重载、取消还原。`leafer-report.json` 记录操作期间 query 请求数、面板和图表Canvas引用、Canvas移除次数、提交次数、浏览器RAF帧间隔；操作中要求查询/移除/提前提交均为0，放手提交一次。帧间隔验收为median≤25ms、p95≤50ms，结果适用于本机该样例；截图为 `leafer-drag-collision.png`、`leafer-resize-preview.png`、`leafer-layout-751.png`。目录下原有工作台脚本继续验证十类图表和SQL操作。
