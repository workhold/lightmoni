# API and execution contract

仅管理员，Cache-Control:no-store；统一/api/v1/ops/registry-credentials。
- GET /：脱敏列表、状态、关联应用。
- POST /：name, registry, repository_prefix?, cluster_ids?, username, password, expires_at?。
- PUT /:id：同创建字段+revision；同仓库同账号可省略/留空password，换账号/仓库必须新password。
- POST /:id/revoke：revision；清空秘密并递增。
- DELETE /:id：revision；有应用/发布快照引用则409。

registry仅HTTPS仓库host[:port]或https://host[:port]，无路径/userinfo/query/hash；docker.io/index.docker.io/registry-1.docker.io归一化。repository_prefix是仓库内完整路径前缀，按/边界匹配；多匹配拒绝。用户名禁止冒号/控制字符，密码允许Token且受长度限制。expires_at为空永久，非空必须未来时间。

应用资源原有API增加spec.registry_credential_ids；不选择保持兼容。每个镜像需要恰好零或一个匹配凭据。授权存在但凭据不可用或目标集群不允许时拒绝，避免匿名绕过。选择凭据但无镜像匹配时不给节点秘密。

执行新增operations.platform.registry-auth.v1；旧节点返回registry_auth_agent_upgrade_required。registry_authorizations与当前应用/凭据重新计算不一致返回registry_authorization_changed，过期/撤销registry_credential_unavailable。节点在当前任务/run目录下创建临时认证，逐镜像临取并验证范围后预拉取；失败只返回固定诊断，取消不回退至匿名、代理或缓存。

生产发布沿用既有Compose及Agent维护契约：固定镜像与匹配Agent包，保留中心状态卷/主密钥、Agent身份和运行权限；未知执行结果沿用现场核对与审计流程，不直接修改数据库或伪造成功回执。
