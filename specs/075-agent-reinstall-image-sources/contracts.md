# 契约

- GET `/api/v1/ops/image-sources` → `{revision,rules:[{source,target,allow_upstream}],updated_at,updated_by}`。PUT 同地址，输入 `{revision,rules}`，CAS 冲突409 `image_sources_revision_conflict`。source 为精确 registry host[:port]（Hub 别名统一 docker.io）；target 为 HTTPS host[:port][/prefix]；最多20条，来源唯一，目标不能指向自身。API 不进行服务器端 URL 请求。
- apply 私有 config `image_sources: {version:1,revision,rules}` 只包含命中镜像的规则；领取重验，旧 Agent 不领取。结果 `image_sources` 记录原 image、source(local/cluster-cache/registry-proxy/upstream-fallback)、固定 image_id 和必要静态 code，不含输出/认证。
- `instance.recovery.inspect`：operation=inspect，新能力 `operations.platform.instance-recovery.v1`；config 冻结实例、主机与旧行版本。Agent 仅枚举，不停止或删除。结果 `{instance_id,absent,container_count,observed_at}`，只有 absent=true 且 count=0 可收尾。调度状态 `agent_reinstall_inspecting` / `agent_reinstall_containers_remain` / `agent_reinstall_inspection_failed` / `agent_reinstall_upgrade_required` / `agent_reinstall_execution_unresolved`。
- 兼容：默认无代理不要求新镜像能力；需要核验的旧实例要求新核验能力。unknown 变更和存活容器继续阻塞。配置保存不主动重启应用或 Docker；新部署/重试使用当前策略。
