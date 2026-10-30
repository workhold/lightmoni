# SDD 044 验收记录

日期：2026-10-30。分支 `codex/044-operations-observability`，基于 SDD 042 的 bc57c82；不包含原工作树未提交的 SDD 043 代码。提交期间远端主干更新到0ab3e25（#17任务中心），已合并主干并保留双方设计章节、主机标签/任务入口及 Agent runner；另将任务中心执行/取消/结果核对元数据接入系统日志。[GitHub PR #20](https://github.com/workhold/lightmoni/pull/20) 以 main 为目标，依赖 #18；未合入、未部署生产。

## 最终行为与存储

- 运维页面及资源详情右上日志图标按需打开 ClickHouse 系统日志；移除正文常驻「最近执行」「执行记录」表和重复的回执提示，保留执行结果详情。
- 商店按数据库、缓存、网站与网关分类，支持数量、关键词组合、无匹配提示及安装返回时保留条件。
- 主机可查看实际实例对应的平台应用、全部 Docker 快照（含停止与外部容器）；应用列表支持主机和集群组合筛选，实际实例查询使用实例表而非截断的状态摘要。
- 每个应用自动派生监控入口，无需创建大盘。按集群、部署、容器查询 CPU、内存、网络和磁盘速率及增量 stdout/stderr；关联网站提供按集群统计的分钟平均 QPS 和耗时。
- 全部应用自动指标共用 `_lm_metric_lightmoni_application_gauge`，应用日志共用 `_lm_log_lightmoni_application`；公开视图分别为 `metric_lightmoni_application_gauge`、`log_lightmoni_application`。
- 平台运行、Agent、运维/任务/发布、主机生命周期、凭据与 Key 接入、节点移除、终端连接/关闭、告警/响应和 AI 告警提案应用审计及任务中心执行状态，统一进入平台系统表 `_lm_lightmoni_log` / `lightmoni_log`。SQLite 保留事务控制状态和可靠投递 outbox。任务解释脱敏；终端内容、脚本、环境、联系人、通知载荷、AI 对话和加密回执不复制到日志。

## 自动检查

在 runtime 目录运行：

```sh
node --import tsx --test --test-concurrency=1 test/agent.test.ts test/nodes.test.ts test/platform-api.test.ts test/platform-clusters.test.ts test/platform-executor.test.ts test/platform-nginx.test.ts test/ingest-compat.test.ts test/application-observability.test.ts test/task-center-model.test.ts test/task-center.test.ts test/assistant-tasks.test.ts test/managed-machines.test.ts test/node-lifecycle.test.ts
```

169 / 169 通过，0 失败、0 跳过。原始结果见 [runtime-tests.txt](evidence/runtime-tests.txt)。覆盖原平台与 Agent 行为、共享物理表、归属覆盖与跨 Agent 拒绝、系统表禁止业务 Key 写入、清单白名单、队列失败游标不推进、同纳秒多行/跨读取上限补传、末行无换行、outbox 回滚与重试、完整联合主键补录、脱敏解释及各审计来源；超过 overview 100 条窗口的历史回执仍可按 ID 读取、脱敏并限制管理员权限。

`npm --prefix runtime run typecheck`、`npm --prefix web run typecheck`、`git diff --check` 通过。按相关变更选择检查，没有运行全量测试或生产构建。

## 真实 Docker / ClickHouse 贯通

使用 `runtime/test/fixtures/observability-ui-server.ts` 启动隔离夹具、临时 SQLite、两个真实 Node 应用容器和一个真实 OpenResty 容器，连接单独的 ClickHouse 26.8 容器。经过真实 Docker 发现/日志读取、Agent SDK 与持久队列、OTLP HTTP Ingest、ClickHouse 落表及统一只读 Query，不伪造负载或访问日志。夹具仅在 loopback 使用合成管理员和 Agent 凭据；生产认证/心跳另由上述测试覆盖，不声称夹具完成生产接入。

- 三个应用仅产生两张共享应用物理表；实际指标、容器日志和网站访问桶均可查询。
- 24 次真实 HTTP 访问产生网站 QPS；内部健康证明路径不计入访问日志。
- 主机清单包含 35 个真实 Docker，区分本次平台容器、未关联的既有标签容器和外部容器，包含 exited 状态；只对本次三个容器进行创建/删除。
- 主机/主集群分别返回三个应用，备用集群返回一个声明部署；同一订单应用有两个声明集群部署。真实容器运行于同一宿主机，没有把声明的备用部署称为多机实测。
- 系统日志 API 可读取运维回执；超 24 小时查询返回 400，业务 Key 写应用系统表返回 403。

数据见 [live-result.json](evidence/live-result.json)、[api-acceptance.json](evidence/api-acceptance.json)。重跑夹具需设置 `LIGHTMONI_QA_CH_URL` 指向专用测试 ClickHouse，按夹具中的合成测试账户准备用户；不得使用生产数据库。结束时清理夹具创建的容器及专用 ClickHouse。

## 浏览器与视觉

沿用已有深色 Ant Design 运维台、导航、字体与设计变量。桌面 1440×1000、窄屏 390×844，另检查网站空态 200% 图。独立视觉评审不打分；初轮提出的空图歧义、窄屏状态优先级与商店动效证据均已修正/补齐，复核无待修视觉项，见 [visual-review.md](evidence/visual-review.md)。

主 Agent 通过浏览器实际入口连续验收：

| 流程 | 第1次 | 第2次 | 第3次 |
| --- | --- | --- | --- |
| 商店分类 + 无匹配搜索 + 恢复 + 安装入口返回保留条件 | 通过 | 通过 | 通过 |
| 应用容器负载 → 网站 QPS → 真实容器日志 | 通过 | 通过 | 通过 |
| 主机平台应用 → 全部 Docker → 外部容器搜索 | 通过 | 通过 | 通过 |
| 主机与集群组合筛选、刷新后仍有正确应用 | 通过 | 通过 | 通过 |

合并最新主干后，主机应用与 Docker 流程又连续三次通过，主机标签与主机任务入口同时保留。另确认监控页面刷新后保留网站流量标签。安装入口仅进入配置表单，没有提交安装。日志右上入口打开、刷新和回执列可见。

图片/录屏按仓库政策保存在忽略目录 `artifacts/screenshots/specs/044-operations-observability/evidence/`，新克隆需重跑生成；可提交的探测报告位于 [reports](evidence/reports)。三处基本动效：打开商店抽屉、缓存分类指示与内容切换、Redis 安装按钮反馈及配置面板切换，证据 `store-motion/record.mp4` 和三帧；操作日志抽屉证据 `system-logs/record.mp4` 和三帧。数据台没有落地页滚动叙事要求。报告仅有测试 Vite 环境 favicon.ico 404，无业务接口失败或页面横向溢出。

独立评审未覆盖键盘/屏幕阅读器、主机抽屉窄屏；不能从静态图声称这些范围通过。

## 架构同步

适用：新增 Agent 自动观测、心跳目标/清单、共享系统表路由、自动目录/查询及系统 outbox 路径。仓库更新 `docs/system-design.md` 第44章。

[Doca 系统设计基线](https://doca.heyphp.com/#/r/2902a80f-c592-414e-9aed-64fe19f2ed53) 已保存第44章正文及文字数据/控制路径，最终最新完整回读确认文本一致、标题与原章节顺序完整；17 个既有原生图块保留，最新回读含158个节点、159条连线。既有图块此前完整 JSON 对比一致，最后一次修改只替换本章系统日志段落。详见 [doca-readback.json](evidence/doca-readback.json)。

新增填充流程图的原生接口返回500；删除本次空白尝试图块后，改以原生文字段落保存完整路径。没有声称新增图已保存；既有原生图没有转成图片或 Markdown。

## 兼容与限制

需升级中心和 Agent；旧 Agent 没有快照时显示等待采集。既有 OpenResty 需重新发布网站配置后才能产生结构化网站数据；关闭 access_log 时显示无请求数据。主机 Docker 清单上限500并提示截断，遥测查询最多24小时并提示结果截断。Docker host 网络可能不提供独立网卡字节统计。

Docker 原始日志被轮转/删除后无法补回，首次采集读取最近7天；超预算单行保留游标并报告失败。中心成功初始化后的日志进入 outbox；初始化存储前的启动失败仍只能写进程 stderr。业务内部指标继续由 SDK 显式打点，历史业务表不迁移、不删除。

## 2026-10-30 主干合入复核

已同步 origin/main cd03bf5（#15/#18/#19 已合入），保留任务中心默认任务、日历调度、网站多域名独立集群、OpenResty 全局唯一及管理抽屉；同时保留应用主机筛选、分类搜索、监控和系统日志抽屉，DNS 线路与观测 API 同时注册。

- 根目录 `npm run typecheck`、`npm run build`、diff 检查通过。构建有既有第三方 use client 与 bundle 大小提示。
- 根目录 `npm test` 全部完成：Runtime 648 项，627 通过、21 环境跳过、0 失败；AI runtime 71/71；TypeScript SDK 18/18。未将环境跳过项计为通过。
- 在一次性 SQLite/HTTP 夹具 19944 和前端 5175 上执行网站路由浏览器回归，7组流程全部通过、无页面异常，包含域名级集群/权重保存读回、预览隔离、单域名关闭、OpenResty 编辑抽屉、冲突保留输入、手动上游、普通应用编辑、390px和200%操作。
- 另验商店分类+搜索空态+进入安装后返回保留条件，通过；未提交应用安装。合并界面未触发远端主机操作。证据见 evidence/main-integration-ui.json，截图按原政策保留本地忽略目录。
- 额外架构同步不适用：整合两侧已有规格、功能及设计，不新增组件、路径或凭据边界；系统设计27/33/42/44章和原 Doca 回读证据完整保留，未声称本次另行写入在线文档。
