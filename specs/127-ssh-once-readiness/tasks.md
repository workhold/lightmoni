# Tasks: SSH 单次命令发行就绪判断

## Phase 1: Specification and design

- [x] T001 Write SDD127 requirements and acceptance scenarios in specs/127-ssh-once-readiness/spec.md.
- [x] T002 Write implementation and compatibility design in specs/127-ssh-once-readiness/plan.md.
- [x] T003 Write heartbeat and admission contract in specs/127-ssh-once-readiness/contracts/README.md.

## Phase 2: User Story 1 — privileged readiness

- [x] T004 [US1] Add shared evidence rules and signed helper validation in runtime/src/shared/ssh-once-readiness.ts, runtime/src/privileged-executor/runner.ts and runtime/src/server/privileged-executors.ts.
- [x] T005 [US1] Gate privileged readiness and plan creation while preserving the verified release in runtime/src/server/privileged-executors.ts.
- [x] T006 [US1] Add old/new/verified release and offline tests in runtime/test/privileged-executors.test.ts.

## Phase 3: User Story 2 — ordinary jobs and manual tasks

- [x] T007 [US2] Add ordinary Agent single-command evidence, heartbeat validation and queue admission in runtime/src/agent/agent.ts, runtime/src/server/nodes-model.ts and runtime/src/server/agent-jobs.ts.
- [x] T008 [US2] Gate manual task admission without changing scheduled runs in runtime/src/server/task-center.ts.
- [x] T009 [US2] Add focused ordinary job and manual/scheduled task tests in runtime/test/agent-jobs.test.ts, runtime/test/task-center.test.ts and runtime/test/task-schedules.test.ts.
- [x] T010 [US2] Render upgrade explanations on the affected host and operations pages.

## Phase 4: User Story 3 — old queued records

- [x] T011 [US3] Prevent SSH invocation for unsupported old queued records in runtime/src/server/center-ssh-dispatch.ts.
- [x] T012 [US3] Verify old queued, claimed and unknown fences in runtime/test/center-ssh-dispatch.test.ts.

## Phase 5: Architecture and validation

- [x] T013 Update docs/system-design.md and Doca system design baseline, preserving native diagrams and reading back the latest version.
- [x] T014 Record focused test, typecheck and Doca readback evidence in specs/127-ssh-once-readiness/validation.md.

## Dependencies

T001–T003 precede implementation. T004 precedes T005–T006; T007–T008 precede T009; T004–T008 precede T011–T012. T013 and T014 follow code and tests. User Story 1 is the minimum independently useful scope.
