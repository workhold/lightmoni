# Agent lifecycle capability inventory

This inventory intentionally separates the capability, its durable authoritative record, and its recovery rule. A UI state or heartbeat is evidence, not authority.

| Capability | Normal path and authority | Durable records | Unknown / fence rule |
| --- | --- | --- | --- |
| Host registration and read-only SSH preflight | Administrator registers host; fixed SSH command verifies target, fingerprint, account privilege, platform, architecture, systemd, and HTTPS reachability. | `managed_machines`, SSH account/credential/check records | Read-only checks may be rerun after expiry. They never prove an Agent absent or installed by themselves. |
| Agent first installation | Reviewed host plan issues a host-bound enrollment and invokes the fixed installer over SSH. | `machine_deployments`, enrollment records, installation receipts | Dispatched failure/disconnection is `unknown`; reconcile read-only or explicitly close the installation record. Never automatically reinstall over an uncertain identity. |
| Resident Agent heartbeat, config, telemetry | Agent uses control credential for config/heartbeat and data credential for telemetry. | `agents`, heartbeat, durable agent queue | Offline only means no fresh heartbeat. It neither proves uninstall nor releases a lifecycle fence. |
| Ordinary scheduled/manual tasks | Task definitions resolve to host snapshots; full-management helper claims exact runs as the unprivileged Agent account. | `task_runs`, task definitions/schedules | Unclaimed queued work can wait; claimed, running, or unresolved `unknown` work fences maintenance until its original record is reconciled. |
| Center-SSH ordinary jobs | Center dispatches a fixed `jobs-once` entry with exact job ID through reviewed SSH credentials. | `agent_jobs` and domain records | Failure before claim can become failed; after claim or dispatch loss remains `unknown` and requires the original record. |
| Privileged managed operations | Root helper presents a signed executor identity; center SSH invokes exact `managed-once` jobs for approved domain plans. | `privileged_jobs`, `task_runs`, domain operation records, executor journal | Managed worker refusal/lease loss is `unknown`; reconcile the exact job and executor journal. Do not replace it with a generic shell. |
| Agent upgrade, rollback, batch | Plan pins host, credential revision, source/target release, SHA, runtime mode, permissions, and expiry. Batch runs hosts serially. | `machine_agent_updates`, `agent_update_rollouts`, stage events | Success requires new boot, exact release, heartbeat/config evidence. Failure, rollback, or unknown pauses the batch; resume only untouched hosts. |
| Standard uninstall | Reviewed plan verifies bound Agent identity, stops managed service, removes fixed program paths, and applies the selected data policy. | `machine_uninstallations`, removal receipts | Dispatch loss is `unknown`; read-only reconciliation or explicit recovery is required. Historical unknown is not success. |
| SSH recovery uninstall / state correction | Administrator supplies reason and current reusable credential; platform verifies bounded remote evidence before changing or correcting state. | recovery plans/audits plus original lifecycle records | Evidence drift keeps the original fence. Recovery never silently rebinds another Agent. |
| Reinstall application-binding recovery | After a reviewed Agent reinstall, automatic inspection and administrator plan transfer prior application ownership. | platform resources, managed jobs, recovery records | Unknown inspections remain fences; successful binding transfer does not rewrite old unknown jobs. |
| Docker environment and managed containers/app operations | Full-management executor reports signed Docker/Compose capability; approved operations execute through fixed managed adapters. | Docker installation records, `agent_jobs`/`privileged_jobs`, service deployment records | Unresolved installation or operation blocks maintenance. Container existence is not business E2E success. |
| Legacy executor bootstrap | Removed first-install executor flow could leave an uncertain bootstrap record. | `machine_executor_bootstraps` | Running/verifying/unresolved `unknown` blocks. With a newer fresh active executor for the same binding, an interactive administrator may close the fence without changing its historical `unknown`. |

## Recurring failure pattern

Most incidents reduce to one of four state confusions:

1. Treating a heartbeat or UI projection as authoritative instead of the durable operation record.
2. Treating `unknown` as failure/success and retrying a side-effecting operation.
3. Treating the in-memory busy lane and durable fences as the same thing.
4. Hiding blocker identity behind a generic 409, leaving no actionable recovery path.

SDD192 fixes the last two omissions and provides the missing closure for the removed legacy bootstrap path. The first two remain intentionally conservative safety rules.
