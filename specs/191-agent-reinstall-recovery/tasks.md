# Tasks: Agent reinstall binding recovery

## Phase 1: Setup

- [x] T001 Create SDD 191 design artifacts in `specs/191-agent-reinstall-recovery/`.

## Phase 2: Foundational control path

- [x] T002 Update Agent reinstall execution flow and safety boundary in `docs/system-design.md`.
- [x] T003 Add exact read only recovery inspection recognition and a focused test in `runtime/src/server/privileged-executors.ts` and `runtime/test/managed-executor-jobs.test.ts`.

## Phase 3: User Story 1, reviewed recovery

**Independent test**: A reviewed host plan takes the lane, completes both checks, and transfers eligible original bindings without remote writes.

- [x] T004 [US1] Cancel only same host queued automatic checks and reject claimed work in `runtime/src/ops/instance-recovery.ts`.
- [x] T005 [US1] Show the retriable active inspection message in `web/src/app/MachineWorkloadRecoveryDialog.tsx`.
- [x] T006 [US1] Test queued, claimed, unknown, and successful reviewed recovery in `runtime/test/platform-clusters.test.ts`.

## Phase 4: User Story 2, stable automatic inspection

**Independent test**: Four old instances use at most one automatic lane and ten unchanged reconciliations enqueue zero repeats after containers remain.

- [x] T007 [US2] Serialize automatic checks by host and defer during active review in `runtime/src/ops/instance-recovery.ts`.
- [x] T008 [US2] Keep valid containers remain observations stable for unchanged snapshots in `runtime/src/ops/instance-recovery.ts`.
- [x] T009 [US2] Test host serialization, stable status, and review suppression in `runtime/test/platform-clusters.test.ts`.

## Phase 5: Verification and delivery

- [x] T010 Run relevant checks and record results in `specs/191-agent-reinstall-recovery/validation.md`.
- [ ] T011 Open and merge a GitHub PR to `main`, then publish and verify a fixed center image in `specs/191-agent-reinstall-recovery/validation.md`.
- [ ] T012 Verify production center and Agent, complete reviewed recovery, and record application and repository results in `specs/191-agent-reinstall-recovery/validation.md`.

## Dependencies

T001 precedes implementation. T002 and T003 precede the recovery flow. T004 to T006 complete reviewed recovery; T007 to T009 complete automatic scheduling. T010 precedes merge and publication; T011 precedes production verification.

## Parallel opportunities

Documentation T002 and executor T003 touch separate files. The implementation tasks in `runtime/src/ops/instance-recovery.ts` are sequential.

## Implementation strategy

Deliver the reviewed path first, then stabilize automatic scheduling. Verify combined behavior before release.
