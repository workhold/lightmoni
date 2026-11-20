# SDD 193 validation

Date: 2026-11-21 Asia/Shanghai.

## Release preparation

- `npm run version:bump -- 0.1.9` updated the registered version surfaces and Compose fixed tag.
- `npm run version:check` passed 46/46 for release 0.1.9.
- `npm run typecheck` passed for Runtime, AI Runtime, and Web.
- `npm run build` passed for TypeScript SDK, Runtime, AI Runtime, and Web.
- `node --import tsx --test test/machine-maintenance.test.ts test/managed-machines.test.ts test/machine-agent-updates.test.ts` passed 190/190.
- `node web/src/app/verify-maintenance-fence-ui.mjs` passed 3/3.
- `node web/src/app/verify-machine-bulk-action-gates-ui.mjs` passed 2/2.
- `git diff --check` passed.

## Pending release gates

The final merged `main` revision, local image build, isolated Compose validation, registry digest, production backup/switch, production UI/MCP checks, and remaining Agent rollout evidence are not complete at this version-preparation commit. They must be recorded here before release completion is claimed.
