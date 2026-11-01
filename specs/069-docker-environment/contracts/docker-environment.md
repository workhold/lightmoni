# Docker 环境契约

- 主机摘要新增 docker_environment：state（ready/missing/daemon_unavailable/permission_denied/unavailable/unknown/stale）、code、observed_at；旧 heartbeat 兼容 unknown。
- GET /api/v1/machines/:id/docker-environment：最近安装记录、主机摘要；仅管理员。
- POST /api/v1/machines/:id/docker-installations：{request_id: UUID, confirmed:true, credential_id?:string}；202 新建或 200 幂等重放，非管理员 403，未确认 400，活动/未知任务 409。
- POST /api/v1/machines/:id/docker-installations/:operationID/verify：只读远端核对，不重新安装；仅管理员，校验主机/凭据/身份。
- 公开记录包含 id、machine_id、state、phase、code、created_at、updated_at、created_by，不返回 SSH 秘密或原始 stdout/stderr。
- succeeded 表示 SSH 验证 Engine/Compose 可用；Agent 访问状态由现有 Docker inventory 单独提供。
- Docker CLI ENOENT 分类为 docker_cli_missing；权限/daemon 错误不能被归为缺失。旧 docker_prerequisite_failed 可引导检查环境。

安装流程对存在绑定的受管 Agent 核对 identity.json 的 agent_id、固定 systemd unit 路径及 User，按需配置 docker 补充组并重启；不匹配时拒绝更改。确认文案包含该权限和重启影响。
