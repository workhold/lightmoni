# SDD 195 validation

Date: 2026-11-21 Asia/Shanghai.

## Production finding

A live production check selected the online, fully managed `zz-bj-1` host. Although it already ran the current Agent, `deploy_agent` connectivity was available and the bulk toolbar incorrectly enabled “部署 Agent”. The server-side overwrite protections were unchanged; this was an entry-state defect.

## Fix checks

- `node web/src/app/verify-machine-bulk-action-gates-ui.mjs`: 2/2 passed.
  - The fixture now deliberately sets `deploy_agent.available=true` while the host remains bound and online.
  - Both the single-host Agent menu and bulk toolbar disable overwrite deployment.
  - SSH preflight, uninstall, remove-node, update history, and maintenance-fence entries retain their intended states.
  - The fixture explains the separate 50-host general batch and 20-host Agent rollout limits and performs no writes.
- `npm --prefix web run typecheck` passed.
- `npm --prefix web run build` passed.
- `npm run version:check` passed 46/46.
- `git diff --check` passed.

## Boundary

This changes only frontend eligibility projection. Server-side identity, remote residue, credential, plan, and lock checks remain authoritative and unchanged.
