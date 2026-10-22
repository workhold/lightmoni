# SDD 021：HTTP 与 AI 工具契约

所有接口均挂在 `/api/v1`，需要登录；创建/应用源码变更、构建、Agent 安装、部署、回滚和修改目标仅管理员可用。响应不包含私钥、密码、token 或原始命令输出。

> 这是目标 API 契约，不是当前已部署接口清单。当前实现的 service API 使用 `repository_url`、`adapter`、`config` 等字段；部署切片已实现管理员服务目标配置、私有 release bundle 上传/摘要校验、管理员有界孤儿 GC、Agent 只读 systemd preflight、lease 绑定制品下载、受管理员保护的 `approve`、状态查询、事件查询、Agent 事件序号/状态校验、最终健康回执状态映射和人工确认的 systemd 回滚 job。Preflight 通过独立 `systemd.probe` job 检查目标 unit 和受控目录，快照绑定目标配置 revision、最多保鲜 10 分钟；它不推进业务部署状态，也不执行主机写入。`approve` 要求有 capability 授权的 health_check，创建不可变 Agent job 并推进到 `agent_ready`；Agent 有序回执可推进阶段状态，缺少健康证据/执行期间取消/租约过期记为 `unknown`。回滚要求新的结构安全 preflight（允许 unit 处于 active/inactive/failed，但路径、入口、current 指针须安全），显示 current 仍为本次部署版本，且 previous version 关联同一 service 的 ready release；Agent 执行 CAS 切换、restart 和 health check，中心仅在回执健康且 current version 等于 previous 时标记 `rolled_back`。首次部署、目标版本变化、无 previous release 或结果未知不自动回滚/重试。扩展 POSIX ACL 与 systemd 业务进程身份仍由管理员按 MVP 运行前提保证。该闭环不代表中心遥测查询、自动补偿、签名构建、硬配额或真实 Linux 主机验收已实现。插桩的只读 propose 已通过 AI 工具提供，管理员 apply HTTP 已接入并执行安全原子写入；源码 release 构建仍待实现。请以 `contracts/README.md` 的当前实现边界和运行时代码为准。

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

当前 systemd MVP 接受已构建 release bundle 的管理员上传；这不是源码构建 API：

`PUT /api/v1/services/:serviceId/releases/:releaseId/artifact`

- 必须为管理员 Cookie 会话并通过 Origin 校验；`Content-Type` 为 `application/vnd.lightmoni.release+gzip`。
- `X-Artifact-SHA256` 必须是 64 位小写/大写 hex；`Content-Length` 为 1..64 MiB。服务端流式收件、计算摘要、与 release 元数据匹配后原子落盘。
- 上传内容必须是 gzip 压缩 USTAR `lightmoni-release-v1.tar.gz`；manifest 的 `service_id`/`version` 必须和 URL 对应 release 匹配，服务端忽略客户端提供的 manifest 状态。中心拒绝常见凭据专用路径、私钥/知名 token 格式、URL/DSN userinfo、凭据查询参数、Basic Auth 和跨行配置中的常见有值凭据字段，错误不得回显匹配内容；该启发式检查不能证明制品无秘密。
- 中心每个运行时进程最多同时接收并校验一个制品上传；容量已满立即返回 `503 artifact_upload_busy` 并关闭连接，不排队。准入槽覆盖流式收件、摘要/格式检查、凭据扫描和 release 状态更新，并在成功、失败或客户端断开时释放。
- 成功返回 `{release_id,sha256,size,status:"ready"}`；容量已满返回 `503 artifact_upload_busy`，digest 不匹配返回 `422 digest_mismatch`，包格式、凭据检查或 service/version 不匹配返回 `422 invalid_artifact` / `422 artifact_release_mismatch`，已就绪不可变 release 不允许替换。失败上传正文留在私有 digest 存储，等待超过 24 小时后由管理员通过 GC 清理；不得因单次失败按 digest 立即删除可能被其他 release 共用的对象。单槽门控限制并发负载，但不消除单个最大 bundle 的内存峰值；硬配额与流式解析仍待实现。
- 制品正文绝不存入静态 `downloads`，状态查询只返回 digest/size/format，不返回服务器本地路径。

管理员可预览或显式确认清理私有制品存储中的孤儿对象：

`POST /api/v1/admin/release-artifacts/gc`

- 需要管理员 Cookie 会话并通过 Origin 校验。请求 `{}` 只执行 dry-run；必须显式传 `{ "confirm": true }` 才会删除。可选 `cursor` 为上一轮返回的不透明游标；其余字段及不合法类型返回 400。
- 只处理所有状态的 `releases.artifact_digest` 都未引用、mtime 早于 24 小时的 sha256 内容文件；保留所有被引用对象，不删除 release 元数据。存储祖先、sha256 和前缀目录必须通过与读取一致的所有者/写权限检查；不跟随存储内部符号链接，不处理硬链接或未知文件名。
- 每轮最多扫描 10,000 项、删除 500 个对象；达到上限时返回 `truncated: true` 和 `cursor`。使用相同确认模式和该游标续扫，防止前面的保留文件让后面的孤儿永久不可达。游标只保存在当前进程，最多有效 5 分钟；重新开始无游标扫描、进程重启或超时会使旧游标失效。每轮重新读取 release 引用，续扫使用首次扫描的保留期截止时间；无效或模式不匹配的游标返回 400。dry-run 和确认删除是独立扫描，不接受跨模式游标。响应只包含扫描/候选/删除/失败计数、字节数和续扫游标，不包含本地路径或 digest。
- 上传与 GC 使用同一进程级互斥槽；忙时上传返回 `503 artifact_upload_busy`，GC 返回 `503 artifact_maintenance_busy`，均不排队。该锁仅覆盖单个中心进程；共享目录多进程写入不属于当前 MVP 支持范围。

Agent 对制品的唯一读取入口：

`GET /api/v1/agents/:agentId/jobs/:jobId/artifacts/:releaseId`

- `Authorization: Bearer <control credential>` 与 `X-LightMoni-Job-Lease: <lease>` 必须同时有效。
- 中心校验 Agent 所属、lease TTL、job 状态以及 job 中 `stage_artifact` 的 release ID、digest 和 service ID；任何不匹配返回 403/409，不提供 filesystem path 或 redirect。
- 响应为原始 bundle bytes、`Content-Length`、`X-Artifact-SHA256` 和 `X-Artifact-Format`。Agent 必须再次校验长度、格式和 SHA-256。

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

当前实现只接受 `adapter: "systemd"`，配置为 `{ "unit":"checkout.service", "release_directory":"/opt/lightmoni/checkout" }`。Unit 和路径由管理员登记，不从 AI 参数或主机发现结果推断。路径不能为根目录、含 `..` 或控制字符。

### `POST /services/:id/targets/:targetId/preflight`

管理员请求：`{"confirm":true}`。服务端从已登记的目标、机器与 Agent 绑定构建唯一只读 action，不接受客户端传入 unit、路径、Agent ID、command 或 capability。目标 Agent 必须在线且已激活。重复请求在相同目标配置下复用排队/执行中的预检；否则创建短期 Agent job，返回 `202` 和预检记录。

Agent 只运行固定参数的 `systemctl show`，读取已登记 release directory 和其中的安全 `current` 版本指针；不建目录、不启停服务、不返回 stdout/stderr。目标路径穿过符号链接时会拒绝就绪；目标 unit 必须执行 `<release_directory>/current/run`，release 根目录须由 root 持有、Agent 组可写、业务用户不可写，且 Agent 的 `ReadWritePaths` 允许访问。只有 unit 处于 `active`/`inactive`、未 masked 且目录存在、权限受控并对 Agent 实际可写才算 ready。中心发给 job 的 action 含一次性 `preflightID` 和 `targetRevision`；最终回执只允许固定字段，必须回显这两个绑定值，中心校验它们与 job/目标 revision 匹配，并校验 `observed_at` 不早于 job 签发时间（允许 60 秒时钟偏差）。超时、取消、错误/畸形输出和跨 job 旧快照返回固定错误状态，不刷新快照有效期。

### `GET /services/:id/targets/:targetId/preflight`

返回 `{id,status,ready,current,snapshot,error_code,created_at,completed_at,expires_at}`。`current` 仅当结果成功、目标/Agent 配置 revision 未改变且距 Agent `observed_at` 未超 10 分钟时为 true。目标状态、配置或机器身份变化使旧快照失效。`ready` 仅说明目标通过只读主机预检，并不表示制品可用或业务部署可执行。

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
  "actions":[{"kind":"stage_artifact","release_id":"release_...","destination":"releases/2026.10.21-1","sha256":"...","size":1234}],
  "verify":[{"kind":"systemd-active","unit":"checkout.service"}],
  "rollback":[],
  "review_url":"/deployments/dep_..."
}
```

创建计划不安装 Agent、不构建、不启动服务。只有 release 已上传且 ready、目标有新鲜 ready 预检、manifest/service/architecture 和 unit 激活入口均匹配时，systemd adapter 才能生成带 release ID/digest/size 的 typed actions。

当前计划会附最近一次预检摘要及目标配置 revision。预检缺失/过期/未就绪时标记 `agent_preflight_required`；release 未上传或摘要状态不匹配时标记 `artifact_missing`。未就绪时不生成生产可执行 actions，审批 API 仍拒绝通用空计划。

### `POST /deployments/:id/approve`

管理员请求：`{"expected_state":"awaiting_approval","confirm":true}`。计划必须包含至少一个 action，以及匹配的 capability 授权 health_check。成功返回 `{id,state:"agent_ready",operation_id}`，并记录 `approved_by` 与状态事件，同时为已激活且最近心跳的 Agent 创建不可变 job。Agent 阶段回执会单调推进部署状态；只有 verifying 后最终回执包含 `health.healthy=true` 才进入 `succeeded`。没有健康证据的成功回执、执行中取消和租约超时标记 `unknown` 并保留最后已知状态；未领取 job 取消则可安全标记 `cancelled`。若目标机器没有已激活且最近心跳的 Agent，返回 `409 agent_not_ready` 并保留计划供重试。重复审批不能跳过状态校验。

管理员取消：`POST /api/v1/deployments/:deploymentId/cancel`，请求 `{"expected_state":"awaiting_approval|agent_ready","confirm":true}`。尚未审批的计划直接转为 `cancelled`；已批准计划只允许在关联 Agent job 仍处于 `queued` 时取消，中心以条件更新原子取消 job 并由同一 SQLite 事务推进部署状态。Agent 已领取任务后返回 `409 deployment_job_already_claimed`，不声称停止了主机上的执行；应先检查主机，再根据实际状态继续处理。状态不匹配返回 `409`，缺少明确确认返回 `400`。

### `GET /deployments/:id`

返回脱敏计划、当前状态、phase、operation ID、previous/目标快照、错误码、健康结果、遥测验证、操作者和时间线摘要。

### `GET /deployments/:id/events`

返回按追加顺序排列的脱敏状态事件：`{id,deployment_id,phase,state,code,summary,actor,created_at}`。Agent 只能通过已鉴权、序号连续的 job event/result 协议推动中心写入事件；原始 Agent 摘要和快照不会暴露在部署详情/时间线。

### `POST /deployments/:id/rollback`

管理员请求：`{"reason":"health_check_failed","confirm":true,"expected_state":"succeeded"}`。只允许管理员确认，且部署计划保存了 previous version/release；latest preflight 必须不同于原部署快照、与当前 target revision 匹配且结构安全（unit 可为 active/inactive/failed，不能 masked；systemd、unit、受控目录、入口、current 指针检查通过），显示 current version 仍为本次部署版本；Agent 在线，previous release 属于同一 service 且为 ready。中心生成固定 typed actions：`activate_release(previous, expectedCurrentVersion=deployed)`、`systemd.restart(registered unit)`、`health_check(systemd-active)`，capability 从动作派生并严格收敛。首次部署、previous release 未登记、preflight 过期、current version 改变或 Agent 不在线均返回 409，不创建 job。相同 operation 的重复调用复用原状态；新的显式重试必须来自终结失败状态并重新执行 preflight。成功回执必须包含 `health.healthy=true` 且 `current_version=previous version` 才转 `rolled_back`；CAS/健康失败为 `failed`，执行中租约过期、版本不匹配或结果未知会终结当前操作、保留 unknown receipt 并要求人工检查；系统不会自动重试。管理员只有在较新的安全 preflight 再次证明 current 仍为本次部署版本后才可显式创建新 operation。

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
