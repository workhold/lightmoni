# 06 主干、认证、存储和联调

负责人：主 Agent。与各模块共享 `internal/shared` 的请求、结果帧、目录、当前用户和依赖接口。

主干负责 Go 主服务及内嵌 UI、SQLite 迁移、ClickHouse 写入账号/只读账号/公共去重视图、OTLP 接入、目录自动发现、全局 Key 来源归因、SQL AST/参数/限额、用户与第三方登录、Agent 心跳/配置/安装包、模板库、统一页面壳、Docker 和 SDK / Agent / 大盘 / 日志 / 告警 / AI 的最终联调。

Key 不绑定 service，不存在 service 白名单或自动路由；认证后的 key_id 由服务端写入。目录严格区分 signal 和 metric subtype，用户不手工拼类型前缀。统一时间范围 `[from,to)`，共享查询入口为所有面板、日志、告警、AI 提供只读限额与 lossless typed frames。

对外功能模块采用 `New(shared.Dependencies)`、`Register(*http.ServeMux)`，后台评估或发送另提供 `Run(context.Context)`。路由统一 `/api/v1`，OTLP `/v1`，前端统一 Ant Design 自绘交互，禁止原生 select/alert/confirm/prompt。各模块独占自己的 feature 和 internal 目录，主干负责修改 main、App 和共享类型。

本地有意义的验证：用户/Key 禁用和会话撤销、管理员保护、OAuth 一次性 state/PKCE/稳定身份、SQL 跨库/外部函数/多语句/宏/大整数、真实 Go/Node → ClickHouse 与 Agent 持久队列恢复。最终部署与浏览器矩阵证据归档 `docs/acceptance.md`。
