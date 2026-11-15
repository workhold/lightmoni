# 164 · AI 助手与 MCP 核心能力收敛及验收

状态：实现与三类隔离真实 E2E 验证完成，等待评审与合并授权。继承 SDD 046/047/134～161 和更新后的核心闭环 Goal。基线为 `main@eb1690b`；不增加新领域工具，不重写已有能力。

## 范围与非目标

本切片只验证并修复核心闭环：内部 AI/外部 Codex 或 Claude → 真实读取 → 原生提案 → 管理员 Web 审批 → 原领域执行 → 原生结果回读，以及撤销/断连/unknown 安全语义。

服务主体、普通程序 OpenAPI/Bearer、无人自动化、全网站/容器/备份/DNS/证书、Agent 后续生命周期、部署回滚、高风险 execute 和模型网关均不属于完成条件。PR #218/#219 保持独立可选扩展，未合入不阻塞本 Goal，也不据此继续扩展。旧范围 Agent 卸载 WIP 仅保存本地 stash，不纳入本 PR。

## 当前能力矩阵（代码事实）

“已实现”指 main 的真实描述符、领域服务与自动化验证；“真实 E2E”必须满足本 SDD 的隔离真实客户端/环境要求，不能以 SDK fixture 代替。

| 领域 / 能力 | 读取 | 提案 | 审批后执行 | 结果查询 | 真实 E2E | 剩余问题 |
| --- | --- | --- | --- | --- | --- | --- |
| 遥测目录与受控查询 | `lightmoni_telemetry_*` 已实现 | 不适用 | 不适用 | 同读取 | 通过（E2E 1） | 无核心阻塞 |
| 日志与 Trace | `lightmoni_logs_search`、`lightmoni_traces_get` 已实现 | 不适用 | 不适用 | 同读取 | 通过（E2E 1 使用真实日志） | 无核心阻塞 |
| 大盘 | `lightmoni_dashboards_*` 已实现 | 本 Goal 不要求 | 不适用 | 同读取 | 非三类必选 | 真实客户端读取可补验 |
| 告警规则/静默 | `lightmoni_alert_rules_*`、`lightmoni_alert_silences_*` 已实现 | `lightmoni_alerts_plan` 已实现 | 原生 AlertProposalService 已实现 | 原生规则/静默回读 | 通过（E2E 2） | 无核心阻塞 |
| 告警事件/通知/统计 | `lightmoni_alert_incidents_*`、`lightmoni_alert_deliveries_*`、统计已实现 | 已有事件/通知提案 | 原生 Alerts/Outbox 已实现 | 原生事件/delivery 回读 | 非三类必选 | 不扩大本轮验收范围 |
| 任务与执行 | `lightmoni_tasks_*`、`lightmoni_executions_*` 已实现 | `lightmoni_tasks_plan` 已实现 | 原生 TaskRunStore + 签名 helper 已实现 | 原生 Task Run/执行索引 | 通过（E2E 3 + 断连重放） | 无核心阻塞 |
| 服务与部署 | `lightmoni_services_*`、`lightmoni_deployments_*` 已实现 | `lightmoni_deployments_plan` 已实现 | 原生 Deployment/Job 已实现 | 原生 Deployment/事件 | 非三类必选 | 真实部署环境未在本轮认证 |
| 运维资源/Run/Schedule | `lightmoni_operations_*` 已实现 | `lightmoni_operations_plan` 已实现 | 原生 OperationsStore/Job 已实现 | 原生 Run/Schedule | 非三类必选 | 真实运维主机未在本轮认证 |
| 主机与 Agent | `lightmoni_hosts_*`、`lightmoni_agent_*` 已实现 | `lightmoni_agent_installations_plan` 已实现 | 原生 MachineDeployment/enrollment 已实现 | 原生安装记录 | E2E 3 使用隔离 Agent，但不认证安装 | 首装 SSH 不作为本轮验收结论 |
| SDK 插桩 | `lightmoni_code_instrumentation_*` 已实现 | 已实现 | 原生 Instrumentation Apply 已实现 | 原生 Plan/Apply | 有隔离真实文件证据，非真实 Codex | 不替代本轮三类客户端验收 |

统一索引只读关联与投影；原生记录是事实来源。当前注册表共 54 个工具，保持名称、Scope 和请求/响应兼容。

## 三类必做真实 E2E

1. **真实客户端读取**：Codex CLI 使用 PAT 连接隔离 LightMoni MCP，完成发现、真实遥测或日志读取；另一个受限 PAT 对明确 Host 越界读取，服务端拒绝。
2. **审批后的中心配置写入**：Codex 创建真实告警静默提案；管理员通过真实 Web API 审批；原生静默记录生效；Codex 回读。
3. **审批后的远端执行**：Codex 对隔离 Agent 上已有脚本任务创建派发提案；管理员 Web 审批；真实签名 helper 领取、以非特权业务账户执行并上报；中心真实 Task Run 成功；Codex 回读。

恢复/安全场景至少覆盖一项：授权撤销阻止未开始执行、断连不重复创建执行，或 unknown 不自动重放。优先同时保留撤销和断连证据。

## 权限与状态机边界

- Web 保留原业务 API；MCP 不直连数据库、Agent、SSH 或审批 Apply。
- AI/MCP 只创建原生提案，管理员在原页面/API 确认；不提供通用 apply/approve/execute、任意 SQL/Shell 或自动批准。
- 稳定 grant 在审批及未开始项领取/启动前复验；queued/running/unknown 不是成功，unknown 不自动重放。
- 模型接入保持现有四协议薄边界；外部 Codex 自行负责模型与费用，不建设网关。

## 完成条件

核心矩阵代码与测试一致；三类真实 E2E 和至少一个恢复场景有可复核证据；反例、回归、类型检查和构建通过；客户端版本、协议、认证、操作、原生 ID 与结果如实记录。未合入时只能报告实现与验证完成、等待评审，不宣布 main 已生效或 Goal 全部完成。
