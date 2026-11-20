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

- No production host was contacted or mutated by this SDD's implementation checks.
- Historical unknown status is not rewritten to success.
- The new closure path never performs SSH or remote mutation; it requires a fresh active executor heartbeat already present in the center.
