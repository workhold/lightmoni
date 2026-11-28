# 接口约定

- 根 Compose 使用固定发布镜像及 `linux/amd64`。源码构建同时加载 `deploy/server/compose.source.yml`，提供 `LIGHTMONI_BUILD_REVISION`，使用本地镜像和 Docker 的默认构建平台。首次源码启动单独拉取 ClickHouse。
- ClickHouse 的 HTTP 请求仍使用受保护的鉴权头。SQL 文本与写入数据放在 POST 正文中，数据库选择和查询参数继续由原有参数传输。
- SSH 失败对调用方提供固定原因与有限退出码。终端或文件会话发现绑定过期时立即清除绑定的凭据访问并关闭会话，共享凭据仍按其自身期限管理。
- `POST /api/v1/assistant/sessions/:id/turns` 可选接收 `request_id`。受理的 `user.message` 事件带同一标识，重复受理返回 HTTP 409 和 `turn_already_accepted`，不重复调用模型和工具。省略字段的请求维持原接口。
- `GET /api/v1/assistant/sessions/:id` 额外返回 `status`，与会话列表按同一规则计算。服务部署和运维提案的待审阅状态从原生计划回读。会话拥有者可以读取已持久化事件并继续显示正在运行的轮次。
- 管理员访问 `/services?service=<id>&deployment=<id>` 时打开对应原生审阅页。带服务 ID 可直接选择服务。裸路径沿用应用管理入口。服务部署页面自动读取所选服务详情和部署时间线。预检、执行、回滚和审批继续通过原接口进行。
- 管理员访问 `/operations?run=<id>` 时查看该运维计划的目标、修订和预览。勾选确认后通过原接口提交对应修订的审批，再回读执行状态。登录后保留这两个审阅链接的参数。
