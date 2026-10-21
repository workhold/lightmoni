# SDD 021：HTTP 与 AI 工具契约

所有接口均挂在 `/api/v1`，需要登录；创建/应用源码变更、构建、Agent 安装、部署、回滚和修改目标仅管理员可用。响应不包含私钥、密码、token 或原始命令输出。

> 这是目标 API 契约，不是当前已部署接口清单。当前实现的 service API 使用 `repository_url`、`adapter`、`config` 等字段；部署切片已实现受管理员保护的 `approve`、状态查询、事件查询和 `rollback_pending` 提案，但不会创建 Agent job 或执行主机动作。插桩的只读 propose 已通过 AI 工具提供，但尚无持久化插桩 plan/apply HTTP、release 构建、Agent job 和真实验证接口。请以 `contracts/README.md` 的当前实现边界和运行时代码为准。

## 通用约束

- JSON 请求必须拒绝未知字段；ID 使用 opaque string；时间使用 UTC RFC3339。
- 需要副作用的请求支持 `Idempotency-Key`，重复请求返回原 operation/plan。
- 错误统一为 `{error:{code,message,details?}}`。`message` 可展示，不包含上游秘密。
- 服务端再次校验用户、目标归属、状态、TTL、revision 和 adapter schema，不能信任 AI 或浏览器带来的状态。

## 服务和插桩

### `POST /services`

请求：

```json
{"name":"checkout","repository_ref":"workspace://checkout","default_mode":"direct"}
```

`default_mode` 只能是 `direct` 或 `agent`；不保存仓库凭据。返回 `{service:{id,name,default_mode,created_at}}`。

### `POST /services/:id/instrumentation/scan`

请求：

```json
{"workspace_ref":"workspace://checkout/42","revision":"sha256:...","languages":["auto"]}
```

返回：

```json
{
  "plan_id":"ip_...",
  "base_revision":"sha256:...",
  "findings":{
    "languages":["typescript"],
    "frameworks":["express"],
    "sdk":{"found":true,"version":"0.x","mode":"direct"},
    "candidates":[{"file":"src/http.ts","kind":"request_boundary","confidence":0.91}]
  },
  "warnings":[],
  "state":"scanned"
}
```

扫描不写文件、不执行项目代码、不构建、不部署。

### `POST /instrumentation-plans/:id/propose`

请求：`{"base_revision":"sha256:...","intent":"add_request_and_error_metrics"}`。

返回 `{plan_id,base_revision,files:[{path,summary,patch,risks}],validation_steps,state:"awaiting_approval"}`。补丁无法安全生成时 `files` 为空并返回 `manual_steps`。

### `POST /instrumentation-plans/:id/apply`

管理员请求：`{"base_revision":"sha256:...","approval":"apply"}`。

成功返回 `{plan_id,state:"applied",result_revision,changed_files}`。revision 不一致返回 `409 revision_conflict`；没有管理员批准返回 `403 approval_required`。

### `POST /services/:id/releases`

请求：`{"source_revision":"sha256:...","version":"2026.10.21-1","arch":"linux-amd64","build_profile":"default"}`。

返回 `{release:{id,service_id,version,sha256,arch,state:"building"|"ready"|"failed"}}`。只有 `ready` release 可放入 deployment plan。

## 目标和部署

### `POST /services/:id/targets`

请求：

```json
{
  "machine_id":"machine_...",
  "agent_id":"agent_...",
  "provider":"systemd",
  "provider_config":{"unit":"checkout.service","release_directory":"/opt/lightmoni/checkout"},
  "health_checks":[{"kind":"http","url":"http://127.0.0.1:8081/health","expected_status":200}]
}
```

`provider_config` 仅允许所选 adapter 的字段；路径必须是受控绝对路径，URL 不得带用户名、密码或 hash。

### `POST /services/:id/deployments/plan`

请求：

```json
{
  "target_id":"target_...",
  "release_id":"release_...",
  "check_id":"ssh-check_...",
  "idempotency_key":"deploy-plan-..."
}
```

返回完整 `deployment`：

```json
{
  "id":"dep_...",
  "state":"awaiting_approval",
  "provider":"systemd",
  "agent_stage":{"required":true,"status":"pending|ready|failed"},
  "probe":{},
  "actions":[{"kind":"stage_artifact","destination":"/opt/lightmoni/checkout/releases/2026.10.21-1","sha256":"..."}],
  "verify":[{"kind":"systemd-active","unit":"checkout.service"}],
  "rollback":[],
  "review_url":"/deployments/dep_..."
}
```

创建计划不安装 Agent、不构建、不启动服务。

### `POST /deployments/:id/approve`

管理员请求：`{"expected_state":"awaiting_approval","confirm":true}`。成功返回 `{id,state:"agent_ready",operation_id}`，并记录 `approved_by` 与状态事件。当前切片只授权下一阶段，不创建或执行 Agent job；若目标机器没有已激活且最近心跳的 Agent，返回 `409 agent_not_ready` 并保留计划供重试。重复审批不能跳过状态校验。

### `GET /deployments/:id`

返回脱敏计划、当前状态、phase、operation ID、previous/目标快照、错误码、健康结果、遥测验证、操作者和时间线摘要。

### `GET /deployments/:id/events`

返回按追加顺序排列的脱敏状态事件：`{id,deployment_id,phase,state,code,summary,actor,created_at}`。事件只由中心状态迁移写入，不能由 Agent 或 AI 直接伪造。

### `POST /deployments/:id/rollback`

管理员请求：`{"reason":"health_check_failed","confirm":true}`。只允许 `failed`/`rollback_pending` 或已批准的激活状态；当前切片生成 `rollback_pending` 审批/执行提案并记录 operation ID，不直接执行回滚。真正的 Agent 回滚 job 和 `rolling_back → rolled_back` 迁移属于后续执行器切片。

## AI 工具

工具名和参数保持结构化：

| 工具 | 权限 | 行为 |
| --- | --- | --- |
| `scan_sdk_instrumentation` | 成员可读，管理员完整 | 只读扫描并返回 `plan_id` |
| `propose_sdk_instrumentation` | 成员可读，管理员完整 | 生成 diff，不写文件 |
| `apply_sdk_instrumentation` | 管理员 | 校验 revision 后应用已批准计划 |
| `propose_service_release` | 管理员 | 创建受控构建提案，不直接发布 |
| `propose_service_deployment` | 管理员 | 运行 probe 并创建 awaiting approval 计划 |
| `get_service_deployment` | 管理员 | 返回脱敏状态 |
| `get_service_deployment_events` | 管理员 | 返回脱敏追加事件时间线，不代表主机执行成功 |
| `approve_service_deployment` | 管理员 | 触发 Agent job，不能携带 shell |
| `rollback_service_deployment` | 管理员 | 生成受限回滚 job |

所有 apply/approve/rollback 工具都应返回 `approval_required` 或 `operation_id`，不能让模型把工具调用本身当作管理员确认。
