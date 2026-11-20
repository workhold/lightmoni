# SDD 192 validation

Date: 2026-11-21 Asia/Shanghai.

## Local implementation checks

- `npm --prefix runtime run typecheck` passed.
- `npm --prefix web run typecheck` passed.
- `npm --prefix runtime run build` passed.
- `npm --prefix web run build` passed.
- `npm run version:check` passed 46/46 for release 0.1.8.
- `git diff --check` passed.

## Targeted regressions

- `node --import tsx --test test/machine-maintenance.test.ts`: 8/8 passed.
  - Covers durable blocker projection, actionable `maintenance_execution_pending` detail, current active-executor evidence, resolved metadata, audit write, repeat-closure rejection, stale heartbeat rejection, and older-install-generation rejection.
- `node --import tsx --test test/managed-machines.test.ts`: 92/92 passed.
  - Covers busy-lane reporting/release and the new API flow that exposes a legacy bootstrap blocker, validates explicit confirmation/reason, closes it with an interactive administrator session, and verifies the durable blocker list becomes empty.
- `node --import tsx --test test/machine-agent-updates.test.ts`: 90/90 passed.
  - Confirms existing install/upgrade/uninstall/unknown/recovery/rollout fencing semantics remain intact after the error-detail change.
- `node web/src/app/verify-maintenance-fence-ui.mjs`: 3/3 browser checks passed.
  - Covers blocker visibility, disabled closure until confirmation and reason, explicit closure request body, unknown preservation, and refreshed empty blocker projection. No production API was accessed; the browser harness used isolated fixtures.

## Boundary

- The new implementation checks and browser harness did not contact production. The separate incident diagnosis below used existing administrator APIs to reconcile one center-side unknown execution and release one interrupted in-memory lane; it did not dispatch SSH or mutate the remote host.
- Historical unknown status is not rewritten to success.
- The new closure path never performs SSH or remote mutation; it requires a fresh active executor heartbeat already present in the center.

## Production incident diagnosis

A read-only review of `zz-bj-1` found its current signed executor active at Agent 0.1.8, while an Agent rollout still returned `maintenance_execution_pending`. The visible managed execution was an unknown privileged job whose worker had exited with `managed_worker_refused`; it was closed through the existing administrator reconciliation API with an audit reason. An interrupted in-memory terminal lane was also released through the existing administrator busy-release API. No SSH command or remote host mutation was dispatched.

After those visible fences were closed, rollout planning still returned `maintenance_execution_pending`. Task-center, privileged-job, installation, uninstallation, and update records exposed through existing APIs no longer explained the blocker. This matches the otherwise-invisible legacy `machine_executor_bootstraps` fence retained from the removed first-install executor flow and motivated SDD192's explicit projection and audited closure path. Production will be re-validated only after this fix is reviewed, merged, released, and deployed.

## Broad agent-lifecycle regression sweep

After the capability inventory was added, the following eleven Runtime files were run together:

`machine-agent-lifecycle`, `machine-agent-runtime`, `machine-installation-recovery`, `machine-installation-recovery-races`, `machine-state-recovery`, `agent-runtime-maintenance`, `agent-job-fence`, `agent-jobs`, `managed-executor-jobs`, `privileged-executors`, and `center-ssh-dispatch`.

Result: **205/205 passed**. The sweep covers first installation/recovery, runtime-mode transitions, standard and recovery removal, task markers, ordinary job leases and SSH dispatch, signed executor policy/permits, unknown-result reconciliation, managed operations, and Docker fences. No existing safety semantic was relaxed.

## Action-gating UI regression

- `node web/src/app/verify-machine-bulk-action-gates-ui.mjs`: 2/2 browser checks passed.
  - A current online fully managed 0.1.8 host shows disabled overwrite deployment, enabled update history, enabled uninstall, and the maintenance-fence entry.
  - With that host selected, SSH preflight/uninstall/remove-node are enabled where applicable; overwrite deployment, host deletion, and a new upgrade rollout are disabled; the helper separately documents 50-host general batches and 20-host Agent rollouts.
- `npm --prefix web run typecheck` and `npm --prefix web run build` passed after the state-gating change.
- A complete `npm --prefix runtime test` sweep was also attempted in this checkout. It was not green in this checkout: generated Agent/SDK archives were absent from `runtime/downloads`, and several live-SSH/network-sensitive cases failed. Two non-release failures (`machine-service-addresses.test.ts` NAT candidates and `node-lifecycle.test.ts` archived-node plan authorization) were independently reproduced on clean `origin/main`, so they are not introduced by this PR. It is not used as this PR's pass signal; the targeted agent lifecycle sweep above remains the relevant regression evidence.

## Production rollout baseline

A read-only production API audit on 2026-11-21 found five online registered hosts. Three were already at the reviewed 0.1.8 release `b9686762ac97` with the expected amd64 artifact SHA; two still reported 0.1.7 and `update_available`. For those two remaining hosts, there were no active queued/running task runs, no unresolved privileged jobs, and no awaiting/running installation or uninstallation records. Historical installation `unknown` records on one host were not treated as success. This baseline will be used after PR release/deployment to verify that new rollout planning exposes any durable fence instead of failing generically; it does not claim the two hosts were upgraded by this PR.
