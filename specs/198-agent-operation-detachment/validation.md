# Validation

- Targeted detachment regressions: `node --import tsx --test test/managed-machines.test.ts test/machine-agent-updates.test.ts test/agent-uninstall-script.test.ts test/agent-uninstaller-download.test.ts test/machine-agent-lifecycle.test.ts` passed 267/267 from `runtime/`.
- The new regression aborts the approving HTTP request during installation readiness, asserts the durable install remains `running`, then lets the bounded readiness timeout produce the existing unknown/recovery evidence.
- Root typecheck: `npm run typecheck` passed Runtime, AI Runtime, and Web.
- Runtime build: `npm --prefix runtime run build` passed.
- Release identity: `npm run version:check` passed 46/46 checks for `0.1.10`.
- `git diff --check` passed.

Pending production evidence:

- Merge and deploy an image containing this operation-signal change.
- Exercise one confirmed Agent mutation while closing/reopening the host page; confirm the operation continues and the reopened UI resumes progress from durable records.
- Confirm a duplicate apply while running returns a conflict and no second remote transaction is dispatched.
