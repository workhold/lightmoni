# SDD 196 validation

Date: 2026-11-21 Asia/Shanghai.

## Release preparation

- Merged `main@2540f84` (PR #270 brand version) into this release branch.
- Included the PR #271 bound-host install-gating fix.
- `npm run version:bump -- 0.1.10` updated all registered release surfaces.
- `npm run version:check` passed 46/46 for 0.1.10.
- `npm run typecheck` passed for Runtime, AI Runtime, and Web.
- `npm run build` passed for TypeScript SDK, Runtime, AI Runtime, and Web.
- `node --import tsx --test test/machine-maintenance.test.ts test/managed-machines.test.ts test/machine-agent-updates.test.ts` passed 190/190.
- `node web/src/app/verify-brand-version-ui.mjs` passed 2/2 and showed `v0.1.10`.
- `node web/src/app/verify-machine-bulk-action-gates-ui.mjs` passed 2/2, including the production counterexample with `deploy_agent.available=true` on a bound online host.
- `node web/src/app/verify-maintenance-fence-ui.mjs` passed 3/3.
- `git diff --check` passed.

## Pending gates

Final merge revision, local linux/amd64 image build, isolated Compose validation, registry publication/digest, production switch, version-badge/fence/button verification, vchive old-update closure, and 0.1.10 Agent rollout evidence remain pending and must be recorded before claiming release completion.
