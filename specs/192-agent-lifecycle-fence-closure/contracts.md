# Contracts

## GET `/api/v1/machines/:id/busy`

Response adds:

```json
{
  "machine_id": "string",
  "busy": false,
  "maintenance_blockers": [
    {"kind":"executor_bootstrap|task_run|agent_job|privileged_job","id":"string","state":"string"}
  ]
}
```

`busy` remains the in-memory terminal/SSH/installation lane. `maintenance_blockers` is read-only and independently lists durable blockers.

## POST `/api/v1/machines/:id/executor-bootstraps/:bootstrapId/reconcile`

Administrator interactive session only.

Request:

```json
{"confirm": true, "reason": "non-empty, <=500 bytes"}
```

Preconditions:

- legacy row is bound to this machine and current Agent;
- row status is `unknown` and has not been resolved;
- a current `privileged_executors` row for the same machine/Agent is `active`;
- that executor has fresh heartbeat and install generation is not older than the legacy bootstrap.

Success keeps `status: "unknown"`, writes `resolved_at/resolved_by/resolution_reason`, and appends `privileged_audit(event="legacy_executor_bootstrap_closed")`. It does not contact or mutate the host.

## Maintenance gate

`maintenanceWorkBusy` ignores only legacy bootstrap rows with non-empty `resolved_at`. All running/verifying/unresolved unknown rows still block. Preparation errors include the same blocker details as the busy projection while preserving HTTP 409.

## Bulk and single-host UI gating

- Single-host Agent management uses “View Agent update” for `agent_update.state=current`, “Verify Agent update” for `unknown`, and “Upgrade Agent” only when an upgrade entry is appropriate. Existing pending/running labels remain unchanged.
- Bulk buttons use the same durable host/agent projection for preliminary eligibility, show eligible/selected counts, and are disabled when no selected target is eligible.
- Upgrade rollouts include only linked hosts whose release state is `update_available` or `unknown`; current, updating, removed, uninstalled, or absent hosts are excluded from a new batch.
- The bulk helper text separately states the 50-host general batch limit and 20-host Agent rollout limit.
- These UI gates are advisory only; every server plan/apply path independently revalidates authoritative state, credentials, fences, and release identity.
