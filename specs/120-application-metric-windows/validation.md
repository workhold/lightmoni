# 验收记录

日期：2026-11-10。

## 结论

截图中的错误来自应用监控批量请求内的 sdk_metrics 查询：其涉及固定窗口 histogram，但原时间条件内联当前时间，一分钟分桶且 source=application-monitoring 未启用已有自动对齐。容器曲线本身成功，SDK 子查询错误显示在共享错误区。

已将 SDK 指标过滤和分桶改为执行器时间宏；固定窗口使用 window_start、非窗口点保留 event_time。应用监控精确来源复用已有窗口对齐并返回元数据，SDK 曲线采用实际对齐范围。容器、网站和日志仍使用原请求范围，错误照常上报。

## 自动化检查

- 新增回归初次为 3 失败，真实复现 `query range boundaries and interval must align to 30 second metric windows`；修复后全部通过。
- `node --import tsx --test test/application-metric-windows.test.ts test/metric-windows.test.ts test/default-telemetry.test.ts test/application-observability.test.ts test/telemetry-followups.test.ts`（runtime 目录）：32 通过，0 失败/跳过。
- `node --import ./runtime/node_modules/tsx/dist/loader.mjs --test runtime/test/core.test.ts runtime/test/security.test.ts`：22 通过，0 失败/跳过，覆盖只读 AST、查询参数与读权限回归。
- `npm --prefix runtime run typecheck`、`npm --prefix web run typecheck`：通过。
- `git diff --check`：通过。提交前已 fetch origin，基于最新 main 47e9969。

## 真实 ClickHouse / HTTP

隔离 ClickHouse 26.8 容器与独立数据库，通过实际 Executor、生产 observability HTTP handler 和合成遥测行验证，不连接用户主机、不执行 Docker 管理动作。

- 七档 10/30/60/300/600/1800/3600 秒及 30+300 秒混合历史全部成功，实际间隔是周期整数倍；已知 sum/count 均值为 20，其他应用数据被排除。
- 仅有与原请求起点重叠的窗口时仍能发现周期，正确读取 window_start；窗口结束事件不再被错误当作新窗口起点。
- 非窗口 histogram 按 event_time 返回已知均值 10；普通 gauge 和 SDK 日志正常。
- 普通 explore 查询保持严格拒绝未对齐时间；应用 HTTP 响应保留原请求 range，实际返回 48 条容器观测、3 条 SDK 指标和 SDK 日志。

证据：[clickhouse-report.json](evidence/clickhouse-report.json)。不声称已验证真实 Agent 采集或生产部署。

## 浏览器

实际 Vite/React 页面 → 本地生产 observability HTTP handler → 实际 Executor → 隔离 ClickHouse。7 个场景通过、7 次遥测请求成功、0 页面异常：容器六图、手动刷新、15 分钟范围、集群选择、集群/部署/容器组合筛选、SDK 指标与日志、既有 15 秒自动刷新。实际查看容器与 SDK 截图，无窗口对齐报错。

证据：[browser-report.json](evidence/browser-report.json)。本地截图：`artifacts/screenshots/specs/120-application-metric-windows/evidence/`。

## 架构与交付

架构影响不适用：仅修复已有查询配方与已有窗口对齐规则的接入；组件职责、数据/控制路径、API/协议、凭据、存储与部署不变。无需 Agent 升级；无需改写系统设计或在线设计副本。

本次使用独立分支/PR；之前单机内存图标题 PR #163 保留，未并入本修复。未授权合并或生产部署。

修复已提交 [GitHub PR #164](https://github.com/workhold/lightmoni/pull/164)，目标 main；等待审阅合入，未部署生产。
