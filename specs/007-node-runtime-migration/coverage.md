# 迁移覆盖矩阵

基线为提交 `1d892c9` 的公开路由注册声明（存档 `contracts/routes-baseline.json`）；动态生成的 `/v1/{logs,metrics,traces}` 展开后共 **141** 个路由。`runtime/test/routes.test.ts` 用实际 Node 注册表逐项验证路径、方法及公开/认证边界，禁止以空路由或 Go 代理替代。

## 行为与证据

| 范围 | Node 实现 | 验证入口 |
| --- | --- | --- |
| SQLite/BLOB/精确整数/事务/旧AES-GCM与bcrypt | shared/sqlite、crypto；server/auth | core.test.ts、security-compat.test.ts、old-data-validation.md |
| 登录/用户/Key白名单与管理员保护/OAuth PKCE绑定/profile | server/auth、oauth、profiles | core.test.ts、security-compat.test.ts |
| OTLP JSON/protobuf/未知字段/纳秒/浮点/幂等/TTL | shared/otlp；server/ingest、catalog | otlp.test.ts、core.test.ts、ingest-compat.test.ts；Go frozen golden |
| 远程停报/采样/排除/SDK config revision | server/settings | core.test.ts、ingest-compat.test.ts；Go center golden |
| SQL AST/CTE/IN/隐藏表/参数/资源限制 | server/query；shared/clickhouse | core.test.ts、security-compat.test.ts、domains-live.test.ts |
| 任务标签/独立任务/旧分组/节点遥测 | server/nodes* | nodes.test.ts、agent.test.ts、agent-live.test.ts |
| Agent CLI/身份/磁盘队列/receipt/重启/转发/目录轮转/采集/拨测 | agent/* | agent.test.ts、otlp.test.ts、agent-live.test.ts、Go SDK integration |
| 大盘/日志/告警/通知/排班/接手/恢复 | domains/* | domains.test.ts、domains-live.test.ts、domain-validation.md |
| Mastra真实worker/SSE取消/模型四协议/用量/价格快照 | assistant/*；ai-runtime | assistant.test.ts、ai-runtime tests、既有模型管理浏览器脚本 |
| 141路由/来源校验/退出回收/静态网页 | server/app、main、core；shared/http | routes.test.ts、http-lifecycle.test.ts、真实API浏览器巡检 |
| Linux双架构发布/安装升级/失败回滚 | scripts/build-agent-release.mjs；deploy/agent | install-release.test.ts、release-live.test.ts、agent-validation.md |

测试文件位于 `runtime/test/`；只有显式设置 QA 地址或发布目录才运行 live 用例。受控供应商回包不等于真实付费服务验收。完整运行证据见 validation.md。

## 兼容与安全收紧

- 不再提供 Go 平台二进制；Agent Linux 包自带固定 Node，要求 glibc >=2.28，当前不提供 musl 包。Go 业务 SDK 仍独立可用。
- 原始 SQLite 表、API 字段和节点队列继续读取。内置中心大盘仅把未改过的 Go 协程面板迁为 Node 资源/事件循环指标，并保存旧历史版本；用户编辑保留。
- Key 的布尔权限字段严格校验，损坏的授权默认拒绝，避免字符串 `false` 被当作 true。
- OAuth token/userinfo 请求不跟随 HTTP 重定向；裸 IN 右侧表标识符必须是可见 CTE 或公开目录表，数组请使用显式表达式；CTE 按依赖声明顺序解析，前向引用和退化递归遮蔽不接受。
- 地址、Cookie、Master Key、OTLP/批次ID、public FINAL视图、通知outbox和AI账本的格式不因语言迁移而重置。

## 逐路由映射

所有实现路径均以 `runtime/src/` 为根；域内细分处理器通过列出的注册入口组合。

| Method | Path | Node 注册入口 |
| --- | --- | --- |
| DELETE | `/api/v1/agent-groups/:group` | `server/nodes.ts` |
| DELETE | `/api/v1/agent-task-labels/:id` | `server/nodes.ts` |
| DELETE | `/api/v1/agent-tasks/:id` | `server/nodes.ts` |
| DELETE | `/api/v1/alerts/groups/:id` | `domains/alerts.ts` |
| DELETE | `/api/v1/alerts/rules/:id` | `domains/alerts.ts` |
| DELETE | `/api/v1/alerts/silences/:id` | `domains/alerts.ts` |
| DELETE | `/api/v1/dashboards/:id` | `domains/dashboards.ts` |
| DELETE | `/api/v1/logs/saved-searches/:id` | `domains/logs.ts` |
| DELETE | `/api/v1/notify/channels/:id` | `domains/alerts.ts` |
| DELETE | `/api/v1/settings/alert-directory-sources/:id` | `domains/alerts.ts` |
| DELETE | `/api/v1/settings/login-providers/:id` | `server/oauth.ts` |
| GET | `/api/v1/agent-groups` | `server/nodes.ts` |
| GET | `/api/v1/agent-install` | `server/install.ts` |
| GET | `/api/v1/agent-task-labels` | `server/nodes.ts` |
| GET | `/api/v1/agent-tasks` | `server/nodes.ts` |
| GET | `/api/v1/agents` | `server/nodes.ts` |
| GET | `/api/v1/agents/:id/config` | `server/nodes.ts` |
| GET | `/api/v1/alerts/annotations` | `domains/alerts.ts` |
| GET | `/api/v1/alerts/events` | `domains/alerts.ts` |
| GET | `/api/v1/alerts/groups` | `domains/alerts.ts` |
| GET | `/api/v1/alerts/incidents` | `domains/alerts.ts` |
| GET | `/api/v1/alerts/incidents/:id` | `domains/alerts.ts` |
| GET | `/api/v1/alerts/instances` | `domains/alerts.ts` |
| GET | `/api/v1/alerts/policy-defaults` | `domains/alerts.ts` |
| GET | `/api/v1/alerts/responders` | `domains/alerts.ts` |
| GET | `/api/v1/alerts/response-statistics` | `domains/alerts.ts` |
| GET | `/api/v1/alerts/rules` | `domains/alerts.ts` |
| GET | `/api/v1/alerts/silences` | `domains/alerts.ts` |
| GET | `/api/v1/alerts/tables` | `domains/alerts.ts` |
| GET | `/api/v1/assistant/billing` | `assistant/index.ts` |
| GET | `/api/v1/assistant/config` | `assistant/index.ts` |
| GET | `/api/v1/assistant/sessions` | `assistant/index.ts` |
| GET | `/api/v1/assistant/sessions/:id` | `assistant/index.ts` |
| GET | `/api/v1/assistant/usage` | `assistant/index.ts` |
| GET | `/api/v1/assistant/usage/details` | `assistant/index.ts` |
| GET | `/api/v1/auth/identities` | `server/oauth.ts` |
| GET | `/api/v1/auth/me` | `server/auth.ts` |
| GET | `/api/v1/auth/notification-profile` | `server/profiles.ts` |
| GET | `/api/v1/auth/oauth/:id/callback` | `server/oauth.ts` |
| GET | `/api/v1/auth/oauth/:id/start` | `server/oauth.ts` |
| GET | `/api/v1/auth/profile` | `server/profiles.ts` |
| GET | `/api/v1/auth/providers` | `server/oauth.ts` |
| GET | `/api/v1/catalog/tables` | `server/core.ts` |
| GET | `/api/v1/catalog/tables/:id/log-sampling` | `server/settings.ts` |
| GET | `/api/v1/dashboards` | `domains/dashboards.ts` |
| GET | `/api/v1/dashboards/:id` | `domains/dashboards.ts` |
| GET | `/api/v1/dashboards/:id/versions` | `domains/dashboards.ts` |
| GET | `/api/v1/keys` | `server/auth.ts` |
| GET | `/api/v1/keys/:id/events` | `server/auth.ts` |
| GET | `/api/v1/logs/:table/events/:event` | `domains/logs.ts` |
| GET | `/api/v1/logs/saved-searches` | `domains/logs.ts` |
| GET | `/api/v1/logs/saved-searches/:id` | `domains/logs.ts` |
| GET | `/api/v1/notify/channels` | `domains/alerts.ts` |
| GET | `/api/v1/notify/channels/:id/callback-url` | `domains/alerts.ts` |
| GET | `/api/v1/notify/deliveries` | `domains/alerts.ts` |
| GET | `/api/v1/overview` | `server/core.ts` |
| GET | `/api/v1/sdk-install` | `server/install.ts` |
| GET | `/api/v1/settings/alert-directory-sources` | `domains/alerts.ts` |
| GET | `/api/v1/settings/instance` | `server/settings.ts` |
| GET | `/api/v1/settings/login-providers` | `server/oauth.ts` |
| GET | `/api/v1/settings/reporting` | `server/settings.ts` |
| GET | `/api/v1/settings/retention` | `server/settings.ts` |
| GET | `/api/v1/settings/sdk-reporting` | `server/settings.ts` |
| GET | `/api/v1/setup` | `server/auth.ts` |
| GET | `/api/v1/templates` | `server/templates.ts` |
| GET | `/api/v1/traces/:trace_id` | `domains/alerts.ts` |
| GET | `/api/v1/users` | `server/auth.ts` |
| GET | `/api/v1/users/:id/notification-profile` | `server/profiles.ts` |
| GET | `/downloads/agent/:file` | `server/install.ts` |
| GET | `/downloads/sdk/:file` | `server/install.ts` |
| GET | `/healthz` | `server/core.ts` |
| GET | `/v1/sdk-config` | `server/settings.ts` |
| POST | `/api/v1/agent-groups` | `server/nodes.ts` |
| POST | `/api/v1/agent-task-labels` | `server/nodes.ts` |
| POST | `/api/v1/agent-tasks` | `server/nodes.ts` |
| POST | `/api/v1/agents/:id/heartbeat` | `server/nodes.ts` |
| POST | `/api/v1/agents/register` | `server/nodes.ts` |
| POST | `/api/v1/alerts/claim` | `domains/alerts.ts` |
| POST | `/api/v1/alerts/groups` | `domains/alerts.ts` |
| POST | `/api/v1/alerts/groups/:id/schedule-preview` | `domains/alerts.ts` |
| POST | `/api/v1/alerts/incidents/:id/ack` | `domains/alerts.ts` |
| POST | `/api/v1/alerts/incidents/:id/escalate` | `domains/alerts.ts` |
| POST | `/api/v1/alerts/incidents/:id/renew` | `domains/alerts.ts` |
| POST | `/api/v1/alerts/incidents/:id/replan` | `domains/alerts.ts` |
| POST | `/api/v1/alerts/incidents/:id/transfer` | `domains/alerts.ts` |
| POST | `/api/v1/alerts/preview` | `domains/alerts.ts` |
| POST | `/api/v1/alerts/rules` | `domains/alerts.ts` |
| POST | `/api/v1/alerts/rules/:id/silence` | `domains/alerts.ts` |
| POST | `/api/v1/alerts/silences` | `domains/alerts.ts` |
| POST | `/api/v1/assistant/models` | `assistant/index.ts` |
| POST | `/api/v1/assistant/sessions` | `assistant/index.ts` |
| POST | `/api/v1/assistant/sessions/:id/cancel` | `assistant/index.ts` |
| POST | `/api/v1/assistant/sessions/:id/turns` | `assistant/index.ts` |
| POST | `/api/v1/assistant/test-connection` | `assistant/index.ts` |
| POST | `/api/v1/auth/login` | `server/auth.ts` |
| POST | `/api/v1/auth/logout` | `server/auth.ts` |
| POST | `/api/v1/dashboards` | `domains/dashboards.ts` |
| POST | `/api/v1/dashboards/:id/copy` | `domains/dashboards.ts` |
| POST | `/api/v1/dashboards/alert-draft` | `domains/dashboards.ts` |
| POST | `/api/v1/keys` | `server/auth.ts` |
| POST | `/api/v1/logs/aggregate` | `domains/logs.ts` |
| POST | `/api/v1/logs/context` | `domains/logs.ts` |
| POST | `/api/v1/logs/saved-searches` | `domains/logs.ts` |
| POST | `/api/v1/logs/search` | `domains/logs.ts` |
| POST | `/api/v1/logs/tail` | `domains/logs.ts` |
| POST | `/api/v1/notify/callbacks/:id/:token` | `domains/alerts.ts` |
| POST | `/api/v1/notify/channels` | `domains/alerts.ts` |
| POST | `/api/v1/notify/channels/:id/test` | `domains/alerts.ts` |
| POST | `/api/v1/notify/deliveries/:id/retry` | `domains/alerts.ts` |
| POST | `/api/v1/query` | `server/core.ts` |
| POST | `/api/v1/settings/alert-directory-sources/:id/sync` | `domains/alerts.ts` |
| POST | `/api/v1/setup` | `server/auth.ts` |
| POST | `/api/v1/users` | `server/auth.ts` |
| POST | `/v1/logs` | `server/ingest.ts` |
| POST | `/v1/metrics` | `server/ingest.ts` |
| POST | `/v1/traces` | `server/ingest.ts` |
| PUT | `/api/v1/agent-groups/:group` | `server/nodes.ts` |
| PUT | `/api/v1/agent-task-labels/:id` | `server/nodes.ts` |
| PUT | `/api/v1/agent-tasks/:id` | `server/nodes.ts` |
| PUT | `/api/v1/agents/:id/group` | `server/nodes.ts` |
| PUT | `/api/v1/agents/:id/labels` | `server/nodes.ts` |
| PUT | `/api/v1/alerts/groups/:id` | `domains/alerts.ts` |
| PUT | `/api/v1/alerts/rules/:id` | `domains/alerts.ts` |
| PUT | `/api/v1/assistant/billing` | `assistant/index.ts` |
| PUT | `/api/v1/assistant/config` | `assistant/index.ts` |
| PUT | `/api/v1/auth/notification-profile` | `server/profiles.ts` |
| PUT | `/api/v1/auth/profile` | `server/profiles.ts` |
| PUT | `/api/v1/catalog/tables/:id` | `server/core.ts` |
| PUT | `/api/v1/catalog/tables/:id/log-sampling` | `server/settings.ts` |
| PUT | `/api/v1/catalog/tables/:id/retention` | `server/settings.ts` |
| PUT | `/api/v1/dashboards/:id` | `domains/dashboards.ts` |
| PUT | `/api/v1/keys/:id` | `server/auth.ts` |
| PUT | `/api/v1/logs/saved-searches/:id` | `domains/logs.ts` |
| PUT | `/api/v1/notify/channels/:id` | `domains/alerts.ts` |
| PUT | `/api/v1/settings/alert-directory-sources/:id` | `domains/alerts.ts` |
| PUT | `/api/v1/settings/login-providers/:id` | `server/oauth.ts` |
| PUT | `/api/v1/settings/reporting` | `server/settings.ts` |
| PUT | `/api/v1/settings/retention` | `server/settings.ts` |
| PUT | `/api/v1/settings/sdk-reporting` | `server/settings.ts` |
| PUT | `/api/v1/users/:id` | `server/auth.ts` |
| PUT | `/api/v1/users/:id/notification-profile` | `server/profiles.ts` |
