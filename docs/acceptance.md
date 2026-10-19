# 全流程与交互验收

2026-10-17 平台已迁移到 Node.js/TypeScript，当前运行与验收入口见 [迁移规格](../specs/007-node-runtime-migration/spec.md)、[验证记录](../specs/007-node-runtime-migration/validation.md)。下文保留各阶段原始验收证据，其中 Go 平台路径和历史测试命令不再作为当前启动入口；Go/Rust SDK 仅保留源码、后续支持，不纳本次发布验收。

2026-10-11 历史多语言验收曾覆盖 Go、JavaScript/TypeScript、Python、Java/Kotlin JVM、C#/.NET、PHP、Ruby、Rust。Java/C#/PHP SDK 已从当前发行版下线；Go/Rust 仅保留源码、后续支持，不纳本次发布验收；当前发布 TypeScript/JavaScript、Python、Ruby；历史测试证据仍保留在 [多语言 SDK 验收](evidence/multilang-sdk/README.md)，当前可用语言以 SDK 接入页和 [SDK 总览](../sdk/README.md) 为准。


2026-10-11：SDK / Agent 接入已拆分 Tab，Key 改为逻辑 table 白名单。权限、旧 Key 迁移、管理流程与三轮浏览器验收见 [接入权限验收](evidence/ingestion-table-keys/README.md)。下文全局 Key 的描述保留此前真实验收背景，当前上报需显式授权 table。

## 2026-10-10 本地实测结果

中心端已按最终 Dockerfile 构建并运行主服务 + ClickHouse 两容器，隔离项目为 `lightmoni-acceptance`，界面 `http://localhost:18380`。开发服务 `18880`、Vite `5173`、ClickHouse `18123` 用于模块集成；本机 Agent 接收 `14318`，已连接最终 Docker 实例。所有凭证均为本测试工作流生成，不读取其他项目密钥。

| 检查 | 结果与证据 |
| --- | --- |
| Go/Node SDK → 主服务 → ClickHouse | 每个服务20请求，Counter汇总、日志20、Span20及trace/span JOIN准确；同一全局Key支持多个service |
| Go/Node SDK → Agent → ClickHouse | 真实本机链路通过；SDK、队列与库中计数一致 |
| 断网与强杀 | 主服务停止时Agent持久化ACK，强杀Agent后队列与安装身份保留；恢复后队列归零，两个离线服务计数仍各20，无翻倍 |
| 主机/进程/拨测 | macOS arm64实际CPU/内存/磁盘/网络与目标进程采集；HTTP 200及TCP连接成功，拨测指标入库；不可读系统进程显示partial诊断 |
| 数值与重试边界 | `1e-10`、`1e200`保留，Int64最大值按value_int精确查询；部分提交/丢ACK/换Key重试保留稳定event_id及首次Key归因；浮点和整数存储迁移未清空数据 |
| 查询与认证 | AST拒绝跨库/私有表/外部函数/多语句/自定义限额；宏、UTC、空数组、大整数及部分查询失败测试通过；Key禁用、用户会话撤销、管理员保护、8字符至72字节密码边界及一次性OAuth state/PKCE/稳定身份测试通过 |
| 大盘 | 多大盘CRUD/复制/revision、SQL/变量/布局/检查器与模板落地；真实CPU/内存、8种图表、阈值/映射/null/颜色、双Y轴与独立对数尺度通过浏览器验收；最终修复点标记隐藏单轴坐标轴及网格，并复核单轴/双轴；[报告](../examples/dashboards/evidence/report.json)、[双轴证据](../examples/dashboards/evidence/dual-axis-report.json)、[坐标轴回归](../examples/dashboards/evidence/axis-guides-report.json) |
| 日志 | 真实Go/Node共485条，分页/筛选/严格类型/上下文/trace/保存CRUD/URL/CSV/实时暂停与恢复；三套浏览器检查通过，含图表tooltip/拖选/键盘下钻及刷新阅读锚点；[矩阵](../examples/logs/VERIFICATION.md) |
| 告警 | 真实CH跨log_app与metric_http_sum，两组同一目标仅一条路由；本地Webhook第一次429后重试，触发与恢复均收到；SQLite重启、SMTP真实TCP收件、签名/业务码/静默/unknown/episode等测试通过；[任务03](tasks/03-alerts.md) |
| AI | 本地模型协议fixture调用list_tables→真实CH run_query→draft_dashboard，会话/SSE/工具时间线回读；浏览器审阅、真实SQL预览、确认保存大盘通过；自动保存检查为false。查询错误、取消与历史range回归通过。此项验证协议与业务集成，不代表真实模型效果 |
| Trace 关联 | 独立 Trace 查询暂时移除；日志详情按 trace_id 筛选关联日志，保留表与绝对时间，实际匹配 1 条 |
| 安装与分发 | 服务内下载Linux amd64/arm64 Agent、安装/卸载脚本、SHA256；实际下载校验和匹配，Linux arm64容器运行version成功。Node/浏览器tgz、Go源码及demo包已提供，Go独立解压后测试通过 |
| 构建与隔离部署 | 全Go race、SDK测试、AI前端协议、TypeScript与生产构建通过；Docker两容器独立部署及主服务重启后用户、数据、大盘保留；主服务数据卷写权限已实测 |
| 独立审阅 | 修复长密码空hash、极小浮点舍入、9表trace失败；另修窄屏日志固定列、双轴刻度，独立实际390px复核通过；[UI记录](evidence/ui-independent-review.md)、[AI复查](../web/src/features/assistant/REVIEW.md) |

低负载快照（不作为峰值保证）：主服务约11 MiB、ClickHouse约594 MiB；前端按路由拆分，入口约218 kB未压缩。日志查询会话最多2,000条/8 MiB、有限TTL，超限明确显示截断，不声称无界快照。

仍未验收：微信/QQ/GitHub/通用OAuth2的真实供应商账号，真实飞书/钉钉/企业微信/Pushplus/邮件/短信投递，真实AI模型效果；缺少用户测试凭证，仅完成本地协议测试。宿主机为macOS，Linux systemd首次安装/升级/卸载流程尚无真实systemd主机验收。未进行掉电硬件证明或与指定Grafana/Kibana版本的规模/性能对比；复杂任意字段覆盖流水线、插件生态和原版查询语言兼容不属于已交付范围。历史原型已经舍入的旧浮点记录无法从现有数据反推原值，新数据保存原始Float64。不能将这些未验收项写为“全部完成”。

状态逐项记录为未实施、已实施、本地测试、真实联调、已验收；不能以计划、mock或截图单独声明完成。验收用隔离ClickHouse Docker、SQLite、本机Agent、Go与Node SDK demo；具体命令与证据在实现后补齐。

## 数据与故障链路

1. 干净部署主服务与ClickHouse，创建管理员；创建两份全局Key，验证两个service共用Key、换Key后新数据来源归因，以及禁用Key错误。
2. Agent采集本机CPU/内存/磁盘/网络/指定进程，HTTP/TCP拨测；两个SDK demo上报日志、trace、counter多维、gauge、histogram；目录自动发现，样例SQL可执行。
3. 断网、Agent强杀重启、主服务丢ACK、部分CH写入失败、spool回收后SDK重试；总计数不翻倍，时间保持原义。满队列/满盘有背压和诊断，SDK内存边界明确。
4. 日志/指标/trace类型分离，多个service查询、Key追踪、错误Key/禁用Key、公私浏览器凭证、只读SQL与资源上限实际验证。

## 核心交互对标

| 大盘（Grafana参考） | 日志（Kibana参考） |
| --- | --- |
| 多大盘创建/复制/保存/删除与并发冲突 | 关键词、多个字段过滤、可禁用chips、全范围时间图 |
| 多SQL、目录、类型化变量/依赖、多选/全部 | 字段搜索/类型/Top值/列配置/宽度/固定列 |
| 常见图表、单位/颜色/图例/阈值/空值/映射 | 原文/JSON/堆栈、同源上下文/trace联动 |
| 布局拖动缩放、面板检查器/原数据、时间拖选 | 稳定分页、补传、长文本、虚拟列表与阅读位置 |
| 共享时间、自动刷新/暂停、取消过期请求 | 实时暂停恢复、积压/窗口边界、失败重查 |
| 样例SQL/图表模板、一键创建并编辑 | 保存检索CRUD/复制/链接/浏览器前进后退 |
| 保存失败保留草稿、刷新/重启读回 | 大盘/告警草稿、目标表与过滤保持一致 |

每一项都从UI入口执行，使用实际SQL结果核对；核心不得因仅实现空壳降级。详细操作见任务01的B系列、任务02的L系列矩阵。插件市场与完整原版语言兼容单独评估，不作为这些核心操作缺失的理由。性能比较固定同数据量/硬件/网络与参考版本后记录，不能未经实测宣称“不比原版差”。

## 用户、告警、AI与交付

- 用户创建/角色/禁用/会话撤销；本地登录和微信/QQ/GitHub/通用OAuth2完整回调/绑定/错误；外部凭证缺失项保持未验收。
- 告警组创建/目标管理，表绑定/批量查看所有配置、规则触发/持续/无数据/错误/恢复/静默，跨表路由去重与重启outbox；每个渠道以供应商实际结果验收，未配置真实账号只标本地协议测试。
- 模板库按数据类型提供图表与SQL样例，接入页快捷创建大盘；修改模板副本不改原模板。
- AI按Doca骨架会话/SSE/中止/工具时间线，读取目录、生成并运行SQL、分析日志、预览大盘草稿与确认保存；日志内提示不能扩大权限，SQL走统一限额；真实provider未配置不能报AI效果已验收。
- UI无原生select/alert/confirm/prompt，键盘/焦点/200%缩放/空数据/权限错误/断网有明确行为；oil-ui三处动效留实际证据。
- 构建、单元/必要集成测试、浏览器完整操作；中心两容器部署、Agent安装/升级/重装/卸载、备份恢复、资源实测和可执行文档。最终输出通过项、未通过项、证据路径，不用笼统“全部完成”。

## Mastra 助手迁移（2026-10-14）

按 GitHub Spec Kit SDD 建立 specs/001-mastra-assistant 的 spec/plan/research/data-model/contracts/tasks。生产模型执行迁移为 Mastra；Go 仍执行工具和保存会话。验收证据和运行命令见该目录 verification.md。真实 SDK + 隔离模型 fixture 验证回执历史、多轮重载、摘要成功/失败、供应商错误、步数/输出限制、取消与用量。历史协议 parser 仅保留在 *_test.go。真实供应商效果与 Docker 镜像构建需分别验证，不以 fixture 替代。当前本地 Doca 为 AGPL-3.0-only，仅参考架构；原先 MIT 移植声明不作为新代码复制授权。

## AI 多协议连接与模型发现（2026-10-14）

按 specs/003-multi-protocol-models 的 SDD 规格完成四种真实 Mastra 原生适配器：OpenAI Chat Completions、Responses、Anthropic Messages、Google Gemini。设置提供独立获取按钮、自动目录发现/协议建议和具体协议选择；模糊 OpenAI 目录必须明确选择。执行限制新增跨协议思考深度（默认跟随模型），模型目录提示改为动态且保留手动输入；34项运行时、26项前端测试和全Go race通过，原生签名/密文的跨worker延续、服务端私有保留、公开响应剔除及转义Key回显保护均有回归证据。生产构建和8080健康检查通过；浏览器实测见该规格目录 verification.md。Huayan未带Key目录查询返回401，未使用真实Key、未调用外部模型；真实供应商兼容性与模型效果仍须配置凭证后验收。

## Python SDK 上报控制（2026-10-14）

按 [SDD 004](../specs/004-python-sdk-reporting/spec.md) 接入平台远程停报、UID 排除与稳定日志采样，配置轮询独立于自监控；指标/链路不受日志规则影响。配置验证失败保留旧快照，停报取消请求并丢弃未确认数据，旧 Span/回包不会在恢复后补交。真实 HTTP、隔离 SQLite 中心和 Agent 转发/持久化接收已验证，详见 [验证记录](../specs/004-python-sdk-reporting/verification.md)。直连接收端为受控 OTLP fixture，本次未新增真实 ClickHouse 全链路或生产环境验收。
