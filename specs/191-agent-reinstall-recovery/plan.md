# Implementation Plan: Agent reinstall binding recovery

**Branch**: `codex/191-agent-reinstall-recovery` | **Date**: 2026-11-20 | **Spec**: [spec.md](spec.md)

## Summary

Use one automatic old instance inspection per host and keep a valid “containers remain” result stable while its target is unchanged. Give an administrator reviewed plan the host lane by cancelling only unclaimed automatic checks; claimed or unknown checks must complete or be audited. Preserve the existing two stage proof and approval transaction. Recognize the exact signed recovery inspection as a read only observation for unknown job reconciliation.

## Technical Context

**Language/Version**: TypeScript on the repository pinned Node runtime.
**Primary Dependencies**: Existing Runtime platform store, AgentJobs, privileged executor, and React management dialog.
**Storage**: Existing SQLite recovery, run, and job tables; no migration.
**Testing**: `runtime/test/platform-clusters.test.ts`, `runtime/test/managed-executor-jobs.test.ts`, Runtime and Web builds.
**Target Platform**: Linux center and managed Agent on current Compose topology.
**Project Type**: Web service with existing management UI.
**Performance Goals**: One automatic check per host; ten unchanged reconciliations queue none after a valid containers remain result.
**Constraints**: No remote application write, no changed approval authority, no widened unknown mutation reconciliation, and no lost audit.
**Scale/Scope**: Host level recovery of up to 50 old instances; production has four.

## Constitution Check

- Existing host authority, signed execution, and human approval remain; pass.
- Unknown mutations remain fenced. The read only exception requires the exact signed, hashed `inspect` payload and matching parent Agent job; pass.
- Current baseline data, identities, and histories are preserved; pass.
- Host execution control flow changes, so `docs/system-design.md` is updated in this PR.
- Credentials remain in runtime stores and never enter source or evidence; pass.

## Project Structure

### Documentation

```text
specs/191-agent-reinstall-recovery/
  spec.md
  checklists/requirements.md
  plan.md
  research.md
  data-model.md
  contracts/recovery.md
  quickstart.md
  tasks.md
  validation.md
```

### Source Code

```text
runtime/src/ops/instance-recovery.ts
runtime/src/server/privileged-executors.ts
runtime/test/platform-clusters.test.ts
runtime/test/managed-executor-jobs.test.ts
web/src/app/MachineWorkloadRecoveryDialog.tsx
docs/system-design.md
```

**Structure Decision**: Reuse existing recovery tables, queue, review API, and UI. Change scheduling and admission where the paths meet; do not create another execution mechanism.

## Post-design Constitution Check

All gates remain satisfied. The control path change is documented in the Agent reinstall section of `docs/system-design.md` in this SDD and PR.
