# SDD 021：部署适配器契约

> 本文件是目标执行契约。当前已实现的 `SystemdDeploymentAdapter` 和 registry 只负责纯逻辑 `probe/plan/apply/verify/rollback` 与 typed action 校验；它们不调用远程主机，也没有接入 `service-deployments` 的 HTTP 状态机或 Agent executor。

适配器是中心的纯计划层。它不能调用 `child_process`、SSH、shell、systemctl、Docker CLI 或 Kubernetes API；这些动作由 Agent executor 在 capability allow-list 内解释。

## 接口

```ts
interface DeploymentAdapter<P extends string, Snapshot, Spec, Plan, Action> {
  readonly provider: P;
  probe(input: { target: Target<P>; snapshot: Snapshot; now?: Date }): ProbeResult<P>;
  plan(input: { id: string; spec: Spec; probe: ProbeResult<P>; now?: Date }): Plan;
  apply(plan: Plan, approved: boolean): ApplyResult<Action>;
  verify(plan: Plan, snapshot: Snapshot): VerificationResult<Snapshot>;
  rollback(plan: Plan): RollbackResult<Action>;
}
```

所有返回值必须是 JSON 可序列化对象，不包含原始命令、secret 或函数。`apply` 只把已批准 plan 转换为 actions；实际执行属于 Agent。

## 通用模型

```ts
type DeploymentState =
  | "draft" | "preflight" | "awaiting_approval" | "agent_ready"
  | "staging" | "activating" | "verifying" | "succeeded"
  | "failed" | "rollback_pending" | "rolling_back" | "rolled_back";

type HealthCheck =
  | {kind:"systemd-active"; unit:string}
  | {kind:"http"; url:string; timeoutMs?:number; expectedStatus?:number}
  | {kind:"tcp"; host:string; port:number; timeoutMs?:number};
```

## systemd MVP

`ServiceTarget`：

```ts
{
  id: string;
  provider: "systemd";
  unit: string;                 // 必须符合受限 .service 名
  releaseDirectory: string;    // 绝对路径，不含 ..，由中心登记
  machineId: string;
  agentId: string;
}
```

`SystemdSnapshot`：`available`、`unitExists`、`activeState`、`enabled`、`currentVersion?`、`currentArtifact?`。坏快照、unit 不存在、systemd 不可用或目标不匹配必须让 `probe.ready=false`。

允许的 `DeploymentAction`：

```ts
| {kind:"stage_artifact"; source:string; destination:string; sha256:string}
| {kind:"activate_release"; releaseDirectory:string; version:string}
| {kind:"systemd"; operation:"daemon-reload"|"enable"|"disable"|"start"|"restart"|"stop"; unit:string}
| {kind:"health_check"; check:HealthCheck}
```

Agent 必须验证：action 的 unit 等于已登记 target.unit；stage destination 位于 releaseDirectory 下；`activate_release.releaseDirectory` 等于已登记目录且 version 来自已批准 release；source、digest 和 release 元数据一致；健康检查 URL/host/port 通过 provider 校验。任何额外 action 或字段都拒绝。

## 错误码

固定错误码包括：`provider_unsupported`、`invalid_target`、`invalid_artifact`、`snapshot_missing`、`systemd_unavailable`、`unit_missing`、`unit_inactive`、`artifact_conflict`、`health_check_failed`、`agent_not_ready`、`job_expired`、`capability_denied`、`digest_mismatch`、`unknown_execution_result`。

## 状态规则

- 计划只能从 `draft/preflight` 到 `awaiting_approval`；未批准计划不能进入 `staging`。
- Agent 激活前不能进入 `agent_ready` 之后阶段。
- `activating`/`verifying` 失败只能进入 `failed` 或 `rollback_pending`，不能直接标记成功。
- `rollback_pending → rolling_back → rolled_back`；回滚失败保留 `failed`、回执和人工处理提示。
- 成功的 release 不可原地修改；再次部署必须引用新的 version/digest。
