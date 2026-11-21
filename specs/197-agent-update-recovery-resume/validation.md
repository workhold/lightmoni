# Validation

- Targeted Agent maintenance runner regression: `node --import tsx --test test/agent-update-runner.test.ts` passed 99/99 from `runtime/`.
- Targeted Runtime update API regression: `node --import tsx --test test/machine-agent-updates.test.ts` passed 90/90 from `runtime/`.
- Runtime build: `npm run build` passed from `runtime/`. Root typecheck: `npm run typecheck` passed runtime, AI runtime, and web.
- Release identity: `npm run version:check` passed 46/46 checks for `0.1.10`.
- `git diff --check` passed.
- New regressions cover actual SIGKILL after the started restore journal, successful same-approval resume, idempotent post-success retry, and refusal on receipt/journal/approval/snapshot/worker/lock drift.

Pending PR review and production evidence:

- Merge the PR and deploy a center image whose pinned runner contains this recovery-resume logic.
- Use the native approved recovery path for the paused `vchive` update; do not claim closure until the durable record is independently read back as `rolled_back` and the host heartbeat/release evidence is verified.
- After the fence closes, create and execute a separately reviewed Agent upgrade to the user-approved later release and record version, source revision, artifact SHA, and heartbeat.
