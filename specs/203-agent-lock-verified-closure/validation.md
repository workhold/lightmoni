# Validation

- Runtime typecheck/build passed.
- Targeted Agent update runner and Runtime API regressions passed 190/190 from `runtime/`:
  `node --import tsx --test test/machine-agent-updates.test.ts test/agent-update-runner.test.ts`.
- `npm run version:check` passed 46/46 for `0.1.11`.
- `git diff --check` passed.

Pending production evidence:

- Merge and deploy an image containing this guarded lock cleanup.
- Read back the exact `vchive` update as `rolled_back`, including worker evidence and before/after fingerprints.
- Verify the maintenance fence is released, SSH/read paths work, and Agent heartbeat remains 0.1.8 until a separately approved 0.1.11 upgrade.
