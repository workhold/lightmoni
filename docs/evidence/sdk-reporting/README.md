# SDK 停报与日志上报规则验收

本目录的截图、参考图和录屏仅保存在本机 [`artifacts/screenshots/docs/evidence/sdk-reporting/`](../../../artifacts/screenshots/docs/evidence/sdk-reporting/)，由 Git 忽略；下文未带路径的图片和录像文件名均相对此目录。文字报告继续保留在仓库中。

2026-10-12：规则在 SDK 记录日志、聚合指标和发送批次之前执行。中心只保存和下发配置，Agent 透传配置与原始冻结批次。业务日志先匹配排除规则，再匹配上报规则，多条上报规则命中取最高保留比例；没有命中就忽略。SDK 整体停报清空未发送数据并取消正在发送的请求，配置轮询继续，以便动态恢复。

当前覆盖 Go、Node / TypeScript 与浏览器 SDK；六种新增语言暂未接入该配置协议。用户、会话采样不等于严格按事件数保留配额。初次启动的 SDK 沿用本地配置，要求从第一条日志执行远程策略时，应在开始业务生产前等待 RefreshConfig / refreshConfig 成功。

## 自动检查

- `go test -race ./sdk/go ./internal/agent ./internal/ingest ./internal/server`：通过。
- `npm --prefix sdk/typescript test`：10 项通过；散列混合调整后又执行四项规则 / 动态停报 / 稳定 UID / 取消发送的针对性回归，全部通过。
- `npm --prefix web run typecheck`、`git diff --check`：通过。
- `node examples/sdk/reporting.mjs`：最终连续三轮通过，真实 React 操作、SQLite 保存读回、动态配置、Node / 浏览器 SDK 和隔离 ClickHouse，未替换 API 响应。

| 轮次 | 独立逻辑表 | 预期/实际保留日志 | metric 总量 | trace | 浏览器 metric |
| --- | --- | --- | --- | --- | --- |
| 1 | sdk_rules_7505428e | 93 / 93 | 1008 | 1 | 2 |
| 2 | sdk_rules_e07c4118 | 100 / 100 | 1008 | 1 | 2 |
| 3 | sdk_rules_7d297ab1 | 97 / 97 | 1008 | 1 | 2 |

每轮产生 1,000 个普通点击和五条 QA / VIP / 排除 UID / 未命中日志，并通过完整 metric 总量证明日志筛选不改聚合数据。整体停报测试取消已缓冲数据、阻止全部信号、保持另一 SDK 实例正常上报，移除规则后恢复且不补传停报窗口。另验证浏览器不持有中心 Key、保存失败时输入保留，以及 390px 无页面横向溢出。

后端测试还检查管理员权限、上报 Key 的表范围、系统 / metric / trace 表禁止日志规则、空白名单、类型严格匹配、错误配置保持旧策略、Agent 本地令牌和断网缓存。Go / TypeScript 测试覆盖冻结重试正文不随日志规则变更、强停报取消发送，以及跨停报窗口的 span 不补传。连续数字 UID 使用散列混合，避免直接使用 FNV 高位时的分布偏差。

## 界面与证据

沿用现有 Ant Design 主题，SDK 停报入口在“数据接入 → SDK 接入”；日志规则入口在“数据接入 → 数据表”的业务日志表。采用表单和独立条件，保留匹配范围、比例与当前规则名称；未引入另一套视觉风格。删除了百分比无意义的尾随零，窄屏规则名称与匹配字段单独成行，Modal 内容滚动、页脚操作保留在视口内。视觉由主 Agent 自检，没有独立评分。

- [桌面日志规则](../../../artifacts/screenshots/docs/evidence/sdk-reporting/log-rules-desktop.png)
- [390px 日志规则](../../../artifacts/screenshots/docs/evidence/sdk-reporting/log-rules-390.png)
- [SDK 停报规则](../../../artifacts/screenshots/docs/evidence/sdk-reporting/sdk-stop-desktop.png)
- [真实保存失败](../../../artifacts/screenshots/docs/evidence/sdk-reporting/save-failure.png)
- [最后一轮结果](report.json)
- [操作录屏](../../../artifacts/screenshots/docs/evidence/sdk-reporting/ui-flow.webm)：复用 Modal 入场、Tabs 指示器切换与共享按钮按压反馈，记录真实操作流程。

测试环境为临时中心 `18882`、前端 `15175`、隔离 ClickHouse `18124`；浏览器业务代理 `18420`。未部署既有运行实例，验收后关闭这些临时进程和容器。复跑时启动隔离 ClickHouse，并通过环境变量 LIGHTMONI_TEST_URL、LIGHTMONI_UI_URL、LIGHTMONI_CH_URL 指向隔离实例；默认测试管理员 rules-admin / rules-demo-password，浏览器代理测试占用 18420。运行前编译 TypeScript SDK。
