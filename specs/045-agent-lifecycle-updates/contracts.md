# 统一契约

## 发行与运行身份

`AgentRelease = {version,source_revision,build_id,state_schema:1,platform:"linux",arch:"amd64"|"arm64",file,sha256}`。
发行包内 release.json 不含包自身摘要；安装 receipt 含 artifact_sha256。心跳新增 `boot_id`、`release:{version,source_revision,build_id,state_schema,artifact_sha256}`，没有 metadata 的旧 Agent 显示未知，不能仅根据 version 判成功。

## HTTP

所有平台路径需用户认证，写接口管理员。

- GET `/api/v1/agent-releases` → `{releases:AgentRelease[]}`。
- GET `/api/v1/machines/:id/agent-updates` → `AgentUpdate[]`；GET `/:updateId` → 单条。
- POST `/api/v1/machines/:id/agent-updates/plan`：`{credential_id?,target_sha256?,action:"upgrade"|"rollback"}` → `AgentUpdate`。upgrade 必须指定目标 SHA；rollback 使用远端保留的上一发行并固定指纹。
- POST `/:updateId/apply`：`{confirm:true}` → 202 操作；POST `/:updateId/cancel`：`{}`；POST `/:updateId/reconcile`：`{credential_id?}`。
- GET `/api/v1/agent-rollouts`；GET `/:id`；POST `/api/v1/agent-rollouts/plan`：`{machine_ids:string[],target_sha256:string,credential_ids?:Record<string,string>}` → 审阅批次。
- POST `/:id/apply|resume`：`{confirm:true}`；POST `/:id/pause|cancel`：`{}`。
- 下载 `/api/v1/machines/:id/agent-updates/:updateId/downloads/:file` 为独立 scope Bearer 认证，文件仅 `bundle.tar.gz`、`update.sh`、`update-runner.mjs`，三份摘要和有效期绑定计划。

`AgentUpdate` 包含 id/machine_id/agent_id/action/status/plan/receipt/error/created_at/started_at/finished_at/review_url。status 为 awaiting_approval/running/verifying/succeeded/rolled_back/failed/unknown/cancelled。plan 含 machine、安全 credential 元数据、current、target、target_revision、expires_at、steps/warnings；绝不包含凭据/票据。current 含 fingerprint、boot_id、发行 metadata；target 为发行固定元数据或保留上一发行。

Rollout 状态 awaiting_approval/running/paused/succeeded/failed/cancelled；包含 items，每项对应独立 AgentUpdate。最多 20 台、串行执行，failed/rolled_back/unknown 暂停；取消后已执行结果保留。

## SSH 维护协议

维护器 `update.sh start` 与 `update-runner.mjs probe/status/commit/rollback`，输入 JSON 仅 stdin，stdout 单个有界 JSON，不混入日志。start 请求包含 `operation_id,expected_agent_id,expected_fingerprint,expected_service_active:boolean,start_deadline,action,target:{version,source_revision,build_id,state_schema,artifact_sha256,arch,fingerprint?},archive_path,confirm_timeout_seconds`。bootstrap 在 root 管理的 `/opt/lightmoni-agent/.update-bootstrap.*` 暂存并校验三文件，下载 token 只通过 stdin 进入 0600 curl 配置；helper 不联网，并在 accepted 前复制包和监督器至持久目录。start 在持锁前后均检查审批的启动期限，禁止断连后延迟启动已失效计划。中心 apply、远端 start 与 worker 切换前核对审批固定的服务运行状态，变化则不切换程序，须重新生成计划。

root 私有事务目录 `/opt/lightmoni-agent/updates/<operation_id>`；`status.json` 包含 `schema:1,operation_id,agent_id,status,from,target,local_health,started_at,updated_at,confirmation_deadline?,finished_at?,error_code?,restored_fingerprint?`；from 含 fingerprint/boot_id/发行字段，target 为审阅发行；local_health 含 service_active/identity_matches/release_matches/boot_id。status 枚举 accepted/preparing/switching/waiting_confirmation/succeeded/rolled_back/failed/rollback_failed。固定已安装 helper 为 `/opt/lightmoni-agent/update-runner.mjs`，通过当前 bundled Node 运行；status 不修改状态，commit 需 `{operation_id,expected_boot_id,expected_target_sha256}`，rollback 需 `{operation_id}`。两者写请求由独立 worker 消费，commit 响应不代表已完成，必须继续读取 succeeded。

start 通过独立 systemd-run worker 异步执行，返回 accepted。commit 校验操作 ID/安装身份/目标包和正在运行的目标程序；rollback 仅对应事务。确认窗口默认 180 秒；中心等待健康最多 120 秒。平台只在 fresh heartbeat 新 boot、目标 release 精确匹配、config_revision 已应用、last_error 空且本地 waiting_confirmation 后 commit。systemd 派发响应不确定时保留锁和持久回执，不能推定未启动。旧受管 0.1.0 Node 包只允许作为升级源和失败自动恢复目标；缺少完整 release/boot 协议的旧包禁止作为主动回退目标。

SSH command builder 导出 probe/start/status/commit/rollback；probe 返回当前指纹、agent_id、受管安装、架构、current/previous metadata 和 active/lock 信息。API 只处理此契约，不能拼接用户脚本。

回退来源允许受管服务 inactive/failed，保留身份、当前程序指纹、兼容域和锁检查；普通升级来源须 active。已持久提交后的 Agent 自然重启不改写原提交 boot：只读核对重新获取当前程序/发行/boot 与新鲜健康心跳，另存 receipt.current_verification。没有精确当前证据则保持 unknown，不能通过核对补发 commit。

受管发行目录及其祖先必须为 root 所有且禁止组/其他用户写入；Agent 服务仍是独立非 root 用户。指纹包含真实发行路径、manifest、安装摘要、launcher、systemd unit、实际 Node 与入口文件的 SHA；新包另校验 manifest 的 node_binary_sha256。它用于受管目录的审批一致性，不作为 root 攻击者篡改整个依赖树的证明。包的整体 SHA 在写入受管目录前核验；TAR 仅允许普通文件、目录和包内部相对软链接，拒绝绝对/穿越路径、硬链接、设备、重复覆盖和经过软链接的写入。
