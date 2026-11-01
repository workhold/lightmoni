# API 与 Agent 契约

- `GET /api/v1/ops/inventory?machine_id=...`：保留 hosts/applications；host 增加 docker_capabilities、online、error、attempted_at、active_job。observed_at 仅代表清单成功时间。
- `POST /api/v1/ops/machines/:id/docker-jobs`：`{operation:"inventory"|"start"|"stop"|"restart",container_id?,confirmed?,request_id}`。管理员认证；写动作 confirmed=true，完整64位小写容器 ID，在线且支持能力。幂等复用同 request_id，不同内容冲突；同主机活动任务避免并发。
- `GET /api/v1/ops/machines/:id/docker-jobs/:jobID`：只返回 ID、动作、容器ID、任务状态及安全回执，不返回控制凭据、lease、原始 Docker 输出。
- Agent 动作 `{kind:"docker",operation,container_id?}`；能力 inventory→docker.inventory，其余→docker.control。固定 default context、shell=false、单次动作、有界超时，变更前后按完整 ID 验证；回执 `snapshot.docker` 含 operation/container_id/inventory；成功同时须 health.healthy=true 和 verifying 阶段。
- 清单最多500项，仅包含既有允许字段，失败安全码及 attempted_at。即时结果总序列化预算与 agent_jobs 128KiB 一致，超限失败，不能宣称成功。
- 未领取超时为 cancelled/job_expired；领取后租约失效或中断为 unknown；不自动重放写命令。
