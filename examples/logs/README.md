# 日志模块真实运行与验收

此目录使用真实主服务、SQLite、Docker ClickHouse 和本机 Agent；Go/Node demo 均走 SDK → Agent → 主服务。浏览器脚本不替换任何 API 响应或数据。

从仓库根目录运行，先按根 README / examples/agent/README.md 启动 ClickHouse、主服务及本机 Agent，编译 TypeScript SDK。

```sh
npm run build --prefix sdk/typescript
LIGHTMONI_ENDPOINT=https://monitor.example.com go run ./examples/logs/go -count 240
LIGHTMONI_ENDPOINT=https://monitor.example.com node examples/logs/node.mjs
```

默认业务表 `acceptance` 自动发现为 `log_acceptance`。两份 SDK 使用 `logs-go-demo`、`logs-node-demo`，共用 Agent 的全局 Key。`LIGHTMONI_LOGS_TABLE` 修改业务表；`LIGHTMONI_LOGS_RUN` 给正文和属性添加可检索标记。样例包含中文、多行堆栈、一条长日志、数字 `status`、布尔 `retryable`、空字符串、来源序号和真实 trace/span 关联。直接主服务路径可另配 `LIGHTMONI_KEY`，Agent 路径无需业务程序保管 Key。

## 自动检查

```sh
LIGHTMONI_LOGS_CH_URL=http://127.0.0.1:18123 go test -race ./internal/logs
node --test web/src/features/logs/model.test.mjs
npm run typecheck --prefix web

LIGHTMONI_ENDPOINT=https://monitor.example.com \
LIGHTMONI_TEST_URL=http://127.0.0.1:18880 \
LIGHTMONI_UI_URL=http://127.0.0.1:5173 \
node examples/logs/smoke.mjs

node examples/logs/interactions.mjs
node examples/logs/chart.mjs
node examples/logs/discover.mjs
```

主服务测试账号默认为根 smoke 工作流的 `local-admin` / `local-demo-password`；可用 `LIGHTMONI_TEST_USER` / `LIGHTMONI_TEST_PASSWORD` 指定现有隔离测试用户。未初始化的主服务由 smoke 创建测试管理员。请对隔离测试实例运行。ClickHouse 集成测试仅创建、删除自己生成的唯一测试表，SQLite 使用临时库。

`smoke.mjs` 产生新的运行标记，运行 Go/Node 各 240 条，确认 480 条准确结果，操作 200/400/480 分页、service 与数字属性过滤、字段、列宽键盘、详情/JSON/同源上下文、保存和分享重载、SQL 参数跳转与返回、CSV，最后再通过 Go SDK 新增 5 条验证实时待处理提示、去重和暂停恢复。成功写入 `results/run.json` 与截图；第二个脚本使用同一真实数据继续执行过滤 chips、保存更新/复制/删除、列顺序/无固定列横向滚动/鼠标调整、长日志、刷新锚点、详情重载、751px 字段 Drawer 和真实错误恢复。

`chart.mjs` 使用同一批 SDK 日志，核对完整时间图聚合计数，实际鼠标触发 tooltip、拖选缩小范围、返回恢复，以及通过分布数据表按 Enter 下钻。

`discover.mjs` 使用最近的真实 SDK fixture，连续执行三轮正文特殊字符、字段表达式/键盘补全、过滤标签、列与换行、详情切换、新标签分享重载、SQLite 保存重开、字段统计、时间选择恢复及窄屏操作。证据写入 `docs/evidence/logs-discover/regression/`。当前联调可用 `LIGHTMONI_TEST_URL=http://localhost:18380 LIGHTMONI_UI_URL=http://localhost:15174 node examples/logs/discover.mjs`；开发页启动命令为 `cd web && npm run dev -- --config src/features/logs/qa-vite.config.mjs`。

结果截图辅助观察；脚本的真实请求、返回计数、数据库读回及可操作断言才是验收证据。脚本删除自己创建的保存检索，不删除已上报的 demo 日志。已执行记录和剩余跨模块验收见 [VERIFICATION.md](./VERIFICATION.md)。

## 并行开发时使用固定构建

热更新会重挂载整个应用，打断浏览器中正在操作的详情。可把完整前端构建到临时目录，并用本目录的仅本机 QA 服务器运行：

```sh
(cd web && node node_modules/vite/bin/vite.js build --outDir /tmp/lightmoni-logs-qa --emptyOutDir)
node examples/logs/serve.mjs /tmp/lightmoni-logs-qa
LIGHTMONI_UI_URL=http://127.0.0.1:15173 LIGHTMONI_ENDPOINT=https://monitor.example.com node examples/logs/smoke.mjs
LIGHTMONI_UI_URL=http://127.0.0.1:15173 node examples/logs/interactions.mjs
LIGHTMONI_UI_URL=http://127.0.0.1:15173 node examples/logs/chart.mjs
```

QA 服务器只监听 `127.0.0.1`，只接受自己页面的 Origin，并将这一测试 Origin 转换为主服务允许的本机开发 Origin `http://127.0.0.1:5173`。可以用 `LIGHTMONI_LOGS_QA_ORIGIN` 设置实际主服务公开 Origin。它负责静态文件和真实 API 代理，不构造接口返回；生产 Origin/CSRF 的验收由主干负责，不能用这个 QA 代理替代。

## 明确边界

历史查询冻结最多 2,000 行、会话行数据共 8 MiB、有效期 2 分钟；全局缓存最多 32 个会话/32 MiB。列表与时间图分别查询，时间图有独立 `histogram_truncated`；不声称 ClickHouse 全局一致快照。重启、到期和容量淘汰返回 410，保留条件重查。

实时每 3 秒按接收时间查询，15 秒重叠，`event_id` 去重。暂停超过 2 分钟、单窗口或待处理缓存超限会暂停并要求完整重查。刷新不会自动插入新行；点击“新日志”才更新有界列表。任意延迟的可见性/补传不在有限重叠窗口的无漏保证之内。

同源上下文清除关键词/属性/级别过滤，保留表和当前时间范围，并限定同 `service` + `source_id`，优先使用 `source_seq` 输出顺序；缺失时使用事件时间近似顺序。每侧最多 100 行。CSV 只导出当前已载入的行，明确显示数量。

结构化检索是可用的字面关键词、服务与类型化字段/属性过滤；SQL 模式限定当前日志表、强制时间范围与资源限制。完整 KQL/Lucene 语言兼容不作为首版承诺。
