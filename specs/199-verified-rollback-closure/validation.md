# Validation

- Targeted Runtime regressions: `node --import tsx --test test/machine-agent-updates.test.ts test/managed-machines.test.ts` passed 183/183 from `runtime/`.
- New regression proves `rollback_failed + recovery_original_unhealthy` closes as `rolled_back` after a fresh matching original probe, while preserving the original rollback error and adding current verification evidence.
- Existing regressions prove fingerprint, service, mode, generation, helper, lifecycle, operation, identity, account, credential, and plan drift still retain the unknown fence and verification gate.
- Runtime `npm run typecheck` and `npm run build` passed.
- Root `npm run version:check` passed 46/46 for 0.1.10.
- `git diff --check` passed.

Production evidence remains separate and must read back the exact vchive durable record as `rolled_back` after deployment, plus fresh heartbeat/release evidence, before reporting the maintenance fence closed.
