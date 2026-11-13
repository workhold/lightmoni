# 145 · 告警事件与通知只读能力

状态：已实现，待 PR 审核。继承 SDD 046/047/134～144 和全平台能力开放 Goal，本切片补齐 Slice 2 审计发现的告警事件、值班时间线和通知投递读取。当前 stacked 基线包含 SDD 138～144；PR #192～#198 未获本轮合并授权，本切片独立创建面向 main 的 PR 并明确依赖，不自动合并。

## 需求与范围

1. 扩展 AlertReadService，复用 Alerts 和 Alert API 的事件/投递筛选，提供 incidents list/get 与 deliveries list。
2. 新增 `alerts.incidents.read` 和 `alerts.notifications.read`；事件详情/时间线和通知投递分别授权，均为安装级高敏权限。
3. 事件列表使用安全摘要，详情保留真实 incident/timeline；通知列表使用安全字段，不返回联系人、供应商响应、payload 或原始错误正文。
4. 内部新增 list_alert_incidents/get_alert_incident/list_alert_deliveries；成员保留既有内部/Web 读取，外部 PAT/OAuth 仍管理员专用。
5. 原 Alert incidents/deliveries HTTP API 与新能力共享筛选和读取，不改变接手、升级、通知 outbox 或重试语义。
6. 不开放接手、确认、分配、通知重试/测试、供应商配置或任何写入。

## 非目标

- 不改变告警事件、通知投递和值班状态机。
- 不提供主机级事件/通知隔离，不把投递 queued/sending/unknown 当作成功。
- 不宣称响应统计、通知渠道配置或其他管理能力已开放。

## 验收

1. 原 Alert API 与新能力使用同一 AlertReadService 筛选；事件、时间线和投递安全字段有真实测试。
2. 两类 Scope 独立，有限主机和外部成员边界生效；联系人/供应商 payload 不泄露。
3. 内部成员可读取，新工具通过 Dispatcher；无写工具新增。
4. 官方 MCP 客户端发现/调用三个能力，原告警/通知回归通过。
5. 相关回归、类型检查、构建和 runtime 全量与 main 基线对比有真实记录。
