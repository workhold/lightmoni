# SDD 021：Agent Job 与执行器契约

> 本文件是 Agent 执行协议契约。当前分支已提供中心侧 job claim/lease/event/result/cancel API、最小 capability executor、Agent 重启 unknown 回执和 Agent 结果到业务 deployment 的脱敏状态映射；签名 job、真实 preflight、中心遥测验证、自动目标复核和最终回滚仍未接入。`agent_ready` 表示等待执行；`succeeded` 只代表 Agent 报告计划内 health_check 通过。

## Job 拉取与租约

Agent 使用 control credential 调用中心：

- `POST /api/v1/agents/:id/jobs/claim`：一次最多领取一个未过期 job；请求带 Agent ID、能力集合和最后 receipt cursor。
- `POST /api/v1/agents/:id/jobs/:job_id/events`：发送阶段事件，支持幂等 sequence。
- `POST /api/v1/agents/:id/jobs/:job_id/result`：提交最终成功/失败回执。
- `POST /api/v1/agents/:id/jobs/:job_id/cancel`：中心取消未开始或可中止 job。

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

- `artifact.stage`：只写入 target.releaseDirectory 下的 immutable release 目录，复制后核对 SHA-256。
- `artifact.activate_release`：只切换 target.releaseDirectory 下已暂存的版本指针；不得接受任意目录或版本。
- `systemd.daemon_reload`、`systemd.enable`、`systemd.start`、`systemd.restart`、`systemd.stop`：只作用于 target 登记的 unit。
- `health.systemd`、`health.http`、`health.tcp`：固定超时和并发，禁止带凭据的 URL。

不提供 `shell.exec`、`file.write_anywhere`、`package.install`、`ssh.forward` 或 `secret.read`。任何未知 capability、越界 path、digest mismatch、过期 job 或超时 action 都在执行前拒绝并审计。
