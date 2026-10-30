# Implementation Plan

## Context / Decisions
基于已提交的集群应用代码 bc57c82；当前工作区 043 未提交内容留在原工作树。Node Agent/center，React/Ant Design，SQLite 管理状态，ClickHouse 遥测。

1. 新增共享应用观测模块：中心从实例表生成 Agent 自身的授权目标，在心跳回包中下发；Agent 根据现有实例标签匹配容器。心跳携带有界、白名单字段的 Docker 快照，不返回 Env、命令、挂载源或任意标签。
2. Agent 独立周期采集（不依赖手工执行 inspect），使用默认 Docker 上下文。应用 gauge 和日志进入现有持久队列。Docker 日志使用时间戳加同时间戳行序号游标，原子持久化批次与游标，分批读取并保留积压。
3. 两张共享系统物理表：`_lm_metric_lightmoni_application_gauge` 与 `_lm_log_lightmoni_application`，对应受统一 Query 管控的公开视图。新逻辑名 `lightmoni_application` 保留为独立系统表，不合并到 lightmoni 自监控。只接收 Agent data 凭据及允许的 gauge/log；中心核验部署实例 agent_id/owner_id/cluster_id并覆盖标准归属字段。
4. OpenResty 输出 escape=json 结构化访问日志，包含网站 ID、状态、耗时和上游地址，不记录查询参数或请求头。网站请求计数/QPS及延迟从共享应用日志按来源事件时间查询，避免重复采集造成指标双计；没有请求数据时显示无请求数据，不以断连推导零流量。网站与后端应用的关联由中心解析已保存的集群网站绑定。
5. 运维历史迁到可复用日志抽屉。商店类别+搜索。主机 Docker/应用抽屉，集群应用跳转；应用监控目录自动从现有应用派生，按部署/容器筛选并通过统一 Query 获取时序和日志。

## Architecture Impact
适用：新增 Agent 自动 Docker 观测职责、心跳配置与清单路径、系统遥测存储路由、应用监控查询入口。同步 `docs/system-design.md` 的 SDD 044 小节与 Doca 同名章节与文字数据路径，保留既有原生图（新增图块写入返回 500，未声称成功）。无新密钥或 SSH 常驻采集路径。Doca 保存及回读结果记录 validation.md。

## UI direction
沿用紧凑运维台：资源列表为主角，次级日志图标位于右上；商店用带数量的分类标签；应用监控显示部署/容器筛选、负载图与日志。Ant 抽屉进出、类别选择过渡、刷新 loading 提供状态反馈，尊重 reduced-motion。代表视口 1440×1000 和窄屏，真实截图自检后独立视觉评审。

## Verification
针对采集游标/归属/共享表/筛选做契约与集成测试，运行相关既有平台、Agent、ingest/catalog检查。类型检查并运行 UI 验收，保存实际截图与结果。可用时使用隔离 Docker 和 ClickHouse 做真实贯通，不以夹具声称真实部署验收。

## 用户补充：系统日志统一
中心运行日志已接 RuntimeMonitor，Agent runtime_events 已有 outbox，但运维/任务/主机生命周期主要是 SQLite。新增系统事件持久 outbox，事务触发器记录白名单元数据，对既有记录幂等补录；复用 Ingest.internal 写入现有 `_lm_lightmoni_log`（公开 `lightmoni_log`）。审批/任务/配置状态不迁离 SQLite。系统日志抽屉通过统一 Query 读取 ClickHouse，保留控制回执详情接口。系统日志采集不因关闭性能自监控而关闭。

全日志表盘点还包括 Key 接入事件、节点移除、终端连接/关闭元数据、告警事件/响应及 AI 告警提案应用审计。这些记录也导出白名单身份、动作和状态；禁止复制终端字节、告警联系人、通知载荷和 AI 对话或加密回执。终端连接/关闭分别形成事件。

提交期间同步主干新合入的 SDD 043 任务中心：保留主机标签与主机任务入口、Agent 新任务 runner 和心跳能力；将 task_runs 的执行/取消/结果核对元数据接入同一 outbox，不导出脚本 stdout/stderr。
