# SDD 021：Agent Job 与执行器契约

> 本文件是 Agent 执行协议契约。当前分支已提供中心侧 job claim/lease/event/result/cancel API、最小 capability executor、Agent 重启 unknown 回执、只读 systemd preflight、私有制品下载/安全解包/版本 symlink 激活和 Agent 结果到业务 deployment 的脱敏状态映射；签名 job、中心遥测验证、自动目标复核和最终回滚尚未接入。`preflighting` 是只读检查阶段，不能推进 service deployment 状态；`agent_ready` 表示业务 job 等待执行；业务 deployment `succeeded` 只代表 Agent 报告计划内 health_check 通过。

## Job 拉取与租约

Agent 使用 control credential 调用中心：

- `POST /api/v1/agents/:id/jobs/claim`：一次最多领取一个未过期 job；请求带 Agent ID、能力集合和最后 receipt cursor。
- `POST /api/v1/agents/:id/jobs/:job_id/events`：发送阶段事件，支持幂等 sequence。
- `POST /api/v1/agents/:id/jobs/:job_id/result`：提交最终成功/失败回执。
- `POST /api/v1/agents/:id/jobs/:job_id/cancel`：中心取消未开始或可中止 job。
- `GET /api/v1/agents/:agent_id/jobs/:job_id/artifacts/:release_id`：仅在 control credential 认证通过、`X-LightMoni-Job-Lease` 有效且该 job 的不可变 action 明确引用此 release/digest 时流式下载一个私有制品。不接受任意 URL；lease 不放在 URL。

Job 结构（当前中心返回的 `actions`、`target` 和能力集合保持不可变；`sha256` 签名字段待后续接入）：

```json
{
  "id":"job_...",
  "agent_id":"agent_...",
  "deployment_id":"dep_...",
  "operation_id":"op_...",
  "issued_at":"2026-10-21T00:00:00Z",
  "expires_at":"2026-10-21T00:10:00Z",
  "capabilities":["artifact.stage","systemd.restart","health.http"],
  "actions":[],
  "sha256":"signature..."
}
```

中心用 Agent 专用 control credential 校验 audience、时间、job ID 和 Agent 归属；job 的 `expires_at` 和租约限制领取窗口与执行时间。Agent 不能修改 actions；相同 deployment/operation 重试返回此前 job。签名和 plan digest 待后续接入前，中心只把 job 作为受限的内部协议，不应据此宣称生产可执行。

## 事件与回执

事件：`accepted`、`staging`、`activating`、`verifying`、`succeeded`、`failed`、`cancelled`、`unknown`。事件字段：`job_id`、`sequence`、`phase`、`code?`、`summary`、`occurred_at`、`snapshot?`。

- `sequence` 从 1 开始连续递增；相同序号和相同内容的重试幂等，序号冲突/缺口返回 409。
- 执行阶段只能按 `accepted → staging → activating → verifying` 前进；同一阶段可重复报告，不允许跳步或回退。
- 终态 event 仅是观察信息，不会结束 job；`/result` 才是最终状态的权威输入。
- 未领取的 queued job 被管理员取消时可安全将部署标记为 `cancelled`。任务被领取后取消、租约过期或 Agent 重启时，目标主机状态不确定，部署回执记为 `unknown` 并保留最后已知 deployment 状态。
- 中心后台每 5 秒执行一次过期扫描：尚未领取且超过 `expires_at` 的 job 标记 `cancelled/job_expired`；租约过期的已领取 job 标记 `unknown/unknown_execution_result`。Agent 不必再次上线才能刷新部署时间线。
- 成功结果要求 job 已进入 `verifying`，且最终 snapshot 包含 `health.healthy=true`。缺少任一条件时中心把 Agent 的成功声称降级为 `unknown`，不会把它记作 deployment failed。

最终回执：

```json
{
  "job_id":"job_...",
  "state":"succeeded|failed|cancelled|unknown",
  "code":null,
  "summary":"unit is active",
  "snapshot":{"active_state":"active","health":{"healthy":true},"current_version":"2026.10.21-1"},
  "started_at":"...",
  "finished_at":"..."
}
```

`summary` 必须脱敏并限制大小；禁止原始 stdout/stderr、环境变量、credential、私钥和 token。Agent 重启后若无法判断激活动作是否完成，回报 `unknown_execution_result`，中心保留最后已知状态并提示人工复核；自动 probe/补偿动作尚未接入。Agent 健康成功不代表中心已验证 ClickHouse 遥测。

## Capability executor

MVP capability：

- `artifact.stage`：以 job ID/release ID 通过受控中心通道取制品；校验压缩包 SHA-256 和长度后，只向 target.releaseDirectory 下的新 immutable release 目录解包。只接受受限 USTAR gzip、根目录固定 `manifest.json` 与可执行 `run`；压缩 ≤64 MiB、解压 ≤256 MiB、条目 ≤10,000，只允许普通文件和目录，拒绝 link/device/PAX/GNU extension、路径逃逸和重复项。
- `artifact.activate_release`：校验目标已登记的 `releaseDirectory`、已暂存版本及当前版本仍等于计划绑定的 `expectedCurrentVersion`，仅切换受控 current symlink；不得接受任意目录或版本。
- `systemd.daemon_reload`、`systemd.enable`、`systemd.start`、`systemd.restart`、`systemd.stop`：只作用于 target 登记的 unit。
- `health.systemd`、`health.http`、`health.tcp`：固定超时和并发，禁止带凭据的 URL。
- `systemd.probe`：单独 job 中只读检查 action 登记且与 target 精确一致的 systemd unit 和 release directory；只报告 systemd 可用性、unit load/active/enabled 状态、目录存在/可写布尔值、安全版本标识、观测时间、一次性 preflight ID 与目标配置 revision。Agent 不返回原始命令输出、不创建目录、不改变 unit 状态；路径穿过符号链接时预检不就绪。只有 `active`/`inactive` 且 unit 未 masked、目录存在且可写时才返回 `ready=true`。

Linux Agent 使用 `/proc/self/fd` 锚定已打开目录句柄并在逐级路径解析中拒绝符号链接；主机上的暂存与版本切换只在 Linux 提供这类安全文件操作的平台执行。`current` 是相对 symlink `releases/<version>`，Agent 先在同一受控目录创建临时 symlink，再原子 rename；systemd unit 必须由管理员预先配置 `ExecStart=<releaseDirectory>/current/run`，Agent 通过固定只读属性检查确认该入口，不修改 unit。macOS 上可开发和运行只读协议测试，但预检的 `filesystem_check_supported=false`、`ready=false`，暂存/切换明确返回 `unsupported_platform`。真实部署执行需在 Linux Agent 上验证。

预检 action：

```json
{
  "kind":"systemd_probe",
  "unit":"checkout.service",
  "releaseDirectory":"/opt/lightmoni/services/checkout",
  "preflightID":"<32 lowercase hex characters>",
  "targetRevision":"<sha256 hex>"
}
```

最终 job result 的 `snapshot.preflight` 包含 `ready`、`systemd_available`、`unit_exists`、`active_state`、`enabled`、`unit_file_state`、`filesystem_check_supported`、`release_directory_exists`、`release_directory_writable`、`current_version`、`observed_at`、`preflight_id` 和 `target_revision`。只有 Agent 支持固定目录句柄安全检查的平台才允许 `filesystem_check_supported=true`；不支持时不能把“未检查”显示成“目录不存在”，且 `ready` 必须为 false。中心校验快照 ID、revision 和观测时间不得早于该 job 的签发时间（容忍最多 60 秒时钟偏差），避免跨 job 重放旧快照。顶层 `snapshot.health.healthy=true` 仅表示 Agent 成功完成了只读探测，不代表目标已符合部署条件；应以 `snapshot.preflight.ready` 作为可部署性判断。缺少或字段类型不符的快照不得被中心保存为成功预检。

只读 job 的事件阶段仅允许 `accepted → preflighting → terminal`，不接受 `staging`、`activating` 或 `verifying`；常规部署 job 不接受 `preflighting`。

不提供 `shell.exec`、`file.write_anywhere`、`package.install`、`ssh.forward` 或 `secret.read`。任何未知 capability、越界 path、digest mismatch、过期 job 或超时 action 都在执行前拒绝并审计。
