# LightMoni 产品约束

整理日期：2026-10-10；2026-10-17 依 [SDD 007：Node 运行时迁移](../specs/007-node-runtime-migration/spec.md) 更新平台技术栈。早期任务与证据保留原始背景，其中 Go 平台实现已经被 Node.js / TypeScript 取代。真实联调和未验收项以 [迁移验证](../specs/007-node-runtime-migration/quickstart.md)、[领域验证](../specs/007-node-runtime-migration/domain-validation.md) 和 docs/acceptance.md 为准，方案条款不代替测试证据。

## 用户已经明确的方向

- 面向个人和四五人的小团队。单套部署共享数据，不引入项目、工作空间、多租户、逐表或大盘 ACL。
- 一体化主服务内置网页、采集、查询、大盘、日志探索、配置、告警和通知。中心端推荐主服务加 ClickHouse 两个容器；SQLite 内嵌保存管理数据。
- 前端确定使用 React 与 TypeScript，使用 oil-ui 整理设计与交互，图表使用 AntV。禁止浏览器原生 select 和 window.alert/confirm/prompt；选择、确认和输入流程使用共享 React 组件。中心与 Agent 均使用 Node.js / TypeScript，运行入口为 `runtime/dist/server/main.js` 与 `runtime/dist/agent/main.js`。发布固定 Node 24.15.0，依赖版本见各 npm lockfile；2026-10-20按用户指定保留本地SDK与中心上报实现：当前接入页提供Go、TypeScript/Node.js、Python、Rust四种record SDK，其他历史语言保留源码兼容。
- Grafana、Kibana、OpenObserve 是功能和交互参考。LightMoni 自己实现功能，不在运行时依赖这三个产品，也不承诺兼容它们的导入格式或查询语言。
- SDK业务初始化必填service/env；table与metric_name在五参数record调用时选择。SDK密钥只按名称创建，所有启用的有效Key可写任意业务表，不绑定service；缺失Authorization仅允许启用的豁免表，无效或空凭据不降级。Agent专用control/data凭据继续按节点和用途鉴权，记录实际凭据ID及接入来源。
- 业务record按table、metric_name和key1…key16固定字符串槽聚合，默认30秒，支持10秒至1小时七档单周期配置。业务指标查询提供逻辑表短名及旧metric_视图；系统遥测统一lightmoni_log/lightmoni_metric_*并以component区分来源。
- 服务和表首次上报后自动发现/创建。只有系统维护数据表结构；SQL 查询只读且受资源上限约束。
- 大盘全局共享，可创建多个大盘，通过 SQL 查询多张表和多个 service，配置多个面板、图表、变量、时间范围与刷新。
- 日志探索参考 Kibana Discover：表和服务筛选、关键词、字段过滤、时间分布、详情、上下文、保存检索、与大盘和 trace 联动。
- 包含用户管理、管理员/成员角色、禁用与会话撤销，及微信、QQ、GitHub、通用 OAuth 2.0 第三方登录。统一绑定本地用户身份；提供供应商应用配置与接入检查。不能把有按钮或 mock 回调当作真实登录验收。
- 通知包括飞书、钉钉、企业微信、微信公众号推送、手机短信/移动推送、电话语音、SMTP 邮件、Webhook。渠道可以配置多份；告警组管理用户、固定/周期排班、多主多备与P0～P3策略，系统设置管理供应商接入，个人资料管理联系方式。支持接手、回执、无人响应升级、静默窗口、日志现场、Trace树与统计；详见[告警响应](alert-response.md)。数据表绑定责任组，规则明确声明来源表并继承组。支持查看所有已配置告警的数据表与规则、事件、发送记录和恢复通知。外部凭证由用户填写。
- “节点助手”使用独立任务和任务标签分发机器指标、HTTP/TCP 拨测与目录日志，使用表单 Tab 设置启停、采集项、目录与目标表。节点与任务可绑定多个标签，任一标签相交即下发；接入选择初始标签生成保存连接的命令。Agent 独立 systemd/进程管理，不随业务启停；目录日志需要增量读取、轮转和重启进度恢复。
- SDK 的 metric 支持自定义维度、按完整维度组合聚合计数，且支持 Gauge/Histogram。Agent 内置 TypeScript SDK，主机指标走相同模型与聚合 API。
- 数据链路为业务 SDK → 本机 Agent → 主服务 → ClickHouse。Agent 内置 SDK 输出直接接入自身队列，不能绕回本机网络造成递归。
- SDK 默认有界内存缓存；Agent 负责磁盘持久化队列、重启恢复、断网重试和补传。保存原始时间，重试不能重复累计指标。只有真正到达持久化边界后才能返回成功确认。
- 浏览器 SDK 通过业务后端转发到主服务。业务后端持有仅允许目标 table 的 Key，浏览器页面无需保存 Key；不引入独立的公开凭证类型。

## 七条开发任务与当前代码归属

| 编号 | 模块 | 专属任务文件 | 主要代码归属 |
| --- | --- | --- | --- |
| 01 | 大盘 | docs/tasks/01-dashboards.md | web/src/features/dashboards、runtime/src/domains/dashboards.ts |
| 02 | 日志探索 | docs/tasks/02-logs.md | web/src/features/logs、runtime/src/domains/logs.ts |
| 03 | 告警与通知 | docs/tasks/03-alerts.md | web/src/features/alerts、runtime/src/domains/alert*.ts |
| 04 | SDK | docs/tasks/04-sdk.md | sdk/{typescript,python,ruby}（Go/Rust 源码保留供后续开发）、examples/sdk |
| 05 | Agent | docs/tasks/05-agent.md | runtime/src/agent、deploy/agent、examples/agent |
| 07 | AI 助手 | docs/tasks/07-ai-assistant.md | runtime/src/assistant、ai-runtime、web/src/features/assistant |
| 06 | 主干与集成 | docs/tasks/06-core.md | runtime/src/server、runtime/src/shared、web/src/app、web/src/shared、deploy/server |

## 并行约束

- 已按用户要求从方案进入并行实现与真实本地验收。外部测试账号由用户配置，不读取其他项目秘密。
- 各模块编辑自己的 runtime/feature/SDK/Agent 与任务文件；共享文件和最终部署由主 Agent 整合。
- 开工前先落地公共契约、类型、模拟响应与应用壳。模块开发基于契约并行，真实数据链路集成有依赖次序。
- 公共 API、query frame、时间语义、表命名和批次幂等由主干维护；模块不能各自实现另一套查询执行器或表路由。
- 不创建用户侧的新聊天任务；本次使用当前聊天中的子 Agent 协作。

## 功能边界

首版应完整打通安装、数据接入、查询、大盘、日志排查、拨测、用户管理、第三方登录、告警组和通知。Grafana/Kibana 核心功能与交互必须逐项对标，不能仅做到出图和列表；具体矩阵见 acceptance.md。插件市场、任意变换流水线、完全相同的 JSON 导入、完整 KQL/Lucene、完整 PromQL、会话回放、企业组织权限不作为首版验收项；值班排班与告警升级已纳入本次范围。

当前发布 TypeScript/JavaScript、Python、Ruby 三种业务 SDK 和轻量浏览器接入。PHP 原生 SDK 下线；Go/Rust 源码保留、后续支持，不生成本次发布包或接入页安装选项，未纳本次发布验收。Node Agent 复用 TypeScript SDK。Linux 双架构 Agent 包自带 Node 24.15.0，要求 glibc ≥ 2.28；平台最终镜像使用 Node bookworm-slim，当前发布不需要 Go/Rust 工具链。所有真实运行、故障恢复和资源占用结果需要实现后验证，方案不能当作测试证明。

## 最终验收硬要求

- 在隔离环境使用真实 ClickHouse 和 SQLite，Node Agent 采集本机数据，SDK 提供业务 demo 验证接入路径。有 Docker 的环境另验收 Compose 镜像；本次 macOS 环境无 Docker，不能把本机 Node 联调记为 Docker 构建或 Linux 实机验收。
- 跑通全部用户流程与故障恢复，保存/刷新/重启后重新读取；不以 mock、静态截图或供应商受理代替完整运行结果。
- 大盘与日志探索对照 Grafana/Kibana 核心操作清单，真实浏览器验证鼠标/键盘、字段配置、时间筛选、查询、错误、保存、刷新与联动。
- 第三方登录和通知先用隔离协议 fixture 验证错误分支，再用已配置并获授权的真实账号完成供应商验收；没有凭证的项保持未验收，不降低完成标准。

当前构建与检查从仓库根目录执行 `npm run setup`、`npm run build`、`npm run typecheck`、`npm test`。脚本按 TypeScript SDK → runtime → ai-runtime → web 的依赖顺序处理；SDK/Agent 下载产物默认位于 `runtime/downloads`。运行中心用 `npm start`，独立节点用 `npm run agent -- run --config /path/agent.json`。
