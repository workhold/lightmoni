# LightMoni 告警响应与值班优化方案

实施方案，2026年10月13日。已按本次确认直接改造；配置与实际API见[告警响应使用说明](alert-response.md)。

将告警从“触发后向地址发送消息”升级为“按责任组找到值班人员，持续跟踪认领，超时通知备班，并提供现场日志与 trace”。告警组改为用户组；邮箱、短信、电话、飞书和 Webhook 的供应商接入统一放入系统设置。规则、值班、联系方式和响应策略分别管理，通过告警事件串联。

本次范围覆盖固定接收人、按天和周等周期排班、多主多备、送达与接听回执、开始处理、处理超时、临时静默与周期窗口、P0 至 P3 通知策略、无人认领升级、SSO 与目录 Hook、现场日志摘要和完整 trace 跳转。以下默认参数是 LightMoni 的建议模板，管理员可以修改；它们不是业界统一标准。

## 业界实践与设计取舍

| 参考 | 官方机制 | 对 LightMoni 的设计意义 |
| --- | --- | --- |
| PagerDuty | 按有序升级层级联系用户或值班表；同层可以通知多人；认领后停止升级。 | 组决定责任归属，值班表决定当时是谁，策略决定下一步联系谁。 |
| Google SRE | Escalator 跟踪人工确认，超时从主值班升级到备值班。 | 停止升级必须有明确的人工响应。 |
| Grafana Cloud IRM | 升级链支持通知、等待及继续升级；排班无人覆盖时可以跳过该目标。 | 把无人值班和无人响应区分，前者立即进入兜底。 |
| Prometheus Alertmanager | 去重、聚合、路由、静默与依赖抑制。 | 控制告警噪声需要独立机制，用户组与告警聚合不能共用一个概念。 |
| PagerDuty | 事件优先级、通知紧急性和源告警严重程度分开；支持按服务时间调整通知。 | 业务影响与通知强度分开，夜间策略单独配置。 |
| OpenTelemetry | 日志的 TraceId 和 SpanId 关联请求上下文。 | 有相同 trace_id 才能直接关联请求；仅时间和 service 相同的日志只能作为现场候选。 |

上述机制分别见 [PagerDuty 升级策略](https://support.pagerduty.com/main/docs/escalation-policies)、[Google SRE 故障跟踪](https://sre.google/sre-book/tracking-outages/)、[Grafana IRM 升级链](https://grafana.com/docs/grafana-cloud/observe-and-act/respond-to-incidents/escalation-and-routing/escalation-chains/)、[Alertmanager 概念](https://prometheus.io/docs/alerting/latest/alertmanager/)、[PagerDuty 事件模型](https://support.pagerduty.com/main/docs/incidents)、[PagerDuty 动态通知](https://support.pagerduty.com/main/docs/dynamic-notifications/)与 [OpenTelemetry 日志模型](https://opentelemetry.io/docs/specs/otel/logs/data-model/)。

采用这些机制，在现有 Go 主服务内实现响应引擎，继续使用 SQLite 持久化，不增加必需的 Redis、消息队列或独立值班服务。Alertmanager 可以作为后续接入源，但不能替代本次的认领、用户值班和响应状态管理。Grafana OnCall OSS 已于2026年3月24日归档，本方案参考当前 Cloud IRM 的产品机制，不引入归档项目作为基础依赖。[Grafana 官方归档说明](https://grafana.com/docs/oncall/latest/set-up/open-source/)

## 确认后的设计

- 告警组管理有效用户、多主多备、组内兜底、固定/天/周/N天循环、临时替班及等级策略；系统设置管理供应商接入，用户设置管理联系方式。
- 普通飞书、钉钉、企业微信机器人用专门的“开始处理”跳转链接，登录并到达告警页即自动POST接手；飞书企业应用用卡片回调。电话接听即接手，不增加IVR按键。短信与邮件带接手链接。
- 事件以规则实例的episode识别，每组独立响应，只有一个owner；接手、恢复或配置取消停止旧代次的待发送任务。
- P0～P3分别配置方式、星期和窗口、提醒间隔、主备/兜底期限、每层次数与处理期限。P2无人响应可按P1通知，同时保留原始P2；窗口外和静默期间暂停有效等待。
- 支持一次性、预约与周期静默，快速10/30/60/120分钟。静默只影响通知，自动恢复和条件判断继续执行。
- 自动保存固定范围的日志片段，真实trace_id跳完整Trace树、瀑布与关联日志；查询有界、脱敏，缺失和截断明确展示。
- SSO字段映射及外部POST目录Hook同步已绑定用户的资料、成员和排班；人工资料优先，目录失败保留最近成功配置。
- 接手率按实际通知的不同组事件去重，统计平均、中位数、P95、接手方式、主备、原始/通知等级，以及同组接手、恢复和取消。

服务尚未上线，按用户确认直接使用新的人员组模型，不增加legacy/managed切换、迁移向导或双发送器。现有渠道凭证与outbox复用，SQLite初始化新响应表。辅助目的地数据仍供底层发送与已有协议测试使用；页面中的组主模型为人员和排班。

## 渠道边界

飞书群自定义机器人支持URL跳转、不支持服务端交互回传，因此链接到达后的接手在应用内完成；企业应用卡片由可信操作者回调接手。[飞书自定义机器人说明](https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot)、[Lark告警卡片与回调示例](https://open.larksuite.com/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message-development-tutorial/the-robot-sends-an-alarm-notification)

电话供应商受理不代表接听。阿里云中间及结束回执、查询通话时长，腾讯云原生接听回执分别转换为接听事实；乱序或重复回调不覆盖负责人和已结束事件。OutId补偿阿里云发送结果丢失，未知提交保留unknown。[阿里云回执说明](https://help.aliyun.com/zh/vms/developer-reference/return-receipt-message-description-and-configuration-process)、[阿里云通话查询](https://help.aliyun.com/zh/vms/developer-reference/api-dyvmsapi-2017-05-25-querycalldetailbycallid)、[阿里云状态码](https://help.aliyun.com/zh/vms/developer-reference/call-status-code)

现有OAuth登录增加UserInfo资料映射；供应商未授权邮箱/手机号时不能假设这些字段存在，也不据此自动合并账户。该扩展不等于实现完整OIDC验证。[OIDC标准Claims](https://openid.net/specs/openid-connect-core-1_0.html#StandardClaims)

## 实现与验收

后端采用持久响应状态、通知代次、哈希接手令牌、投递记录、去重的人员通知记录、审计时间线及回执收件表。窗口恢复/服务重启根据有效时间继续响应，避免回放历史轮次；改变责任组时，即使规则不发周期提醒，也建立当前责任组的响应。开放事件更新策略使用显式“应用当前组配置”。

前端提供告警响应、统计、静默、组排班与策略、系统接入、个人资料、目录Hook及Trace页面。通过原生供应商HTTP/SMTP本地模拟和隔离SQLite验证协议与状态；通过受控浏览器流程验证配置保存、自动接手、现场和桌面/窄屏展示。

具体默认参数、数据契约、配置步骤、统计定义、验证命令及真实账号验收边界见[告警响应使用说明](alert-response.md)。真实供应商账号尚未配置；不将协议测试声明为真实短信/拨号/机器人投递成功。
