# SDD 021：Agent Job 与执行器契约

> 本文件是 Agent 执行协议契约。当前分支已提供中心侧 job claim/lease/event/result/cancel API，以及最小 capability executor 和 Agent 重启 unknown 回执；签名 job、真实 preflight、业务部署状态闭环和遥测验证仍未接入，因此只有 `agent_ready` 的计划仍必须视为未执行。

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

最终回执：

```json
{
  "job_id":"job_...",
  "state":"succeeded|failed|cancelled|unknown",
  "code":null,
  "summary":"unit is active",
  "snapshot":{"active_state":"active","current_version":"2026.10.21-1"},
  "started_at":"...",
  "finished_at":"..."
}
```

`summary` 必须脱敏并限制大小；禁止原始 stdout/stderr、环境变量、credential、私钥和 token。Agent 重启后若无法判断激活动作是否完成，回报 `unknown_execution_result`，中心先重新 probe 再决定补偿动作。

## Capability executor

MVP capability：

- `artifact.stage`：只写入 target.releaseDirectory 下的 immutable release 目录，复制后核对 SHA-256。
- `artifact.activate_release`：只切换 target.releaseDirectory 下已暂存的版本指针；不得接受任意目录或版本。
- `systemd.daemon_reload`、`systemd.enable`、`systemd.start`、`systemd.restart`、`systemd.stop`：只作用于 target 登记的 unit。
- `health.systemd`、`health.http`、`health.tcp`：固定超时和并发，禁止带凭据的 URL。

不提供 `shell.exec`、`file.write_anywhere`、`package.install`、`ssh.forward` 或 `secret.read`。任何未知 capability、越界 path、digest mismatch、过期 job 或超时 action 都在执行前拒绝并审计。
