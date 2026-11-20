# Recovery behavior contract

## Automatic reconciliation

- Inspect at most one eligible old instance per machine at a time.
- With an active reviewed plan, queue no automatic checks for that machine and retain a pending application state.
- Return a valid `agent_reinstall_containers_remain` on an unchanged snapshot without queuing another check.
- Keep existing validation and fence rules for changed snapshots, failed checks, and unresolved results.

## Administrator API

The request and success shapes of `POST /api/v1/machines/:id/workload-recoveries/plan` and `POST /api/v1/machines/:id/workload-recoveries/:operation/apply` remain unchanged.

Plan creation cancels only queued automatic checks on that machine. If an automatic check is claimed or unresolved, it returns HTTP 409 `workload_recovery_auto_inspection_pending`; the administrator can retry after the original job ends or is audited. A rejected transaction leaves no partial plan or cancellation.

Plan and apply still require current Agent evidence, human approval, immutable snapshots, and an atomic transfer. Unknown results never become success.

## UI

The recovery dialog explains the active check and prompts a later retry. It continues to display the original record after an uncertain response and does not submit another approval automatically.
