# Tasks: Mastra monitoring assistant

## Phase 1 — Setup
- [X] T001 Initialize Spec Kit, constitution and feature artifacts in .specify/ and specs/001-mastra-assistant/.
- [X] T002 Research installed Mastra contracts and pin ai-runtime/package.json dependencies.

## Phase 2 — Foundation
- [X] T003 Define TypeScript private transport and Go Runtime interface in ai-runtime/src/protocol.ts and internal/assistant/runtime.go.
- [X] T004 Add fixture-based worker integration tests in internal/assistant/runtime_test.go and context tests in ai-runtime/test/.

## Phase 3 — US1 Reliable monitoring conversation
- [X] T005 [US1] Implement Mastra worker, tool callbacks, full-stream mapping and complete checkpoints in ai-runtime/src/runner.ts.
- [X] T006 [US1] Route production Go Service through Mastra with bounded host-authorized tool dispatch in internal/assistant/service.go and runtime.go.
- [X] T007 [US1] Verify catalog/query/draft compatibility, secrets, unknown tools, isolation and worker errors with actual worker fixtures.

## Phase 4 — US2 Long investigations
- [X] T008 [US2] Implement complete-round context budgeting and tool-free summarization in ai-runtime/src/context.ts and runner.ts.
- [X] T009 [US2] Persist validated summary prefixes, configurable execution limits and periodic text checkpoints in internal/assistant/types.go and service.go.
- [X] T010 [US2] Verify long history, cancellation during summary, failed summary and oversize latest request.

## Phase 5 — US3 Control and inspect execution
- [X] T011 [US3] Record model-reported usage and validate cancel/step-limit behavior in runtime.go and worker.
- [X] T012 [US3] Display compaction/usage and execution settings in web/src/features/assistant/.
- [X] T013 [US3] Ship worker and Node runtime through deploy/server/Dockerfile and document README.md startup.

## Phase 6 — Verification
- [X] T014 Run Go race tests, worker tests/typecheck/build, web typecheck/build; record evidence and limitations in specs/001-mastra-assistant/verification.md.
- [X] T015 Review spec/contract/task alignment, restart local service with Mastra and verify health; update docs/acceptance.md and docs/contracts.md.

## Dependencies and strategy
T001–T004 precede US1; US2 and US3 depend on transport. Implement and verify one user story at a time. Source edits are sequential; independent build/read checks may run together. No parallel implementation agents are needed. Fixtures test actual Mastra execution, not a substitute loop. Closure requires explicit evidence; missing real provider and Docker are reported limits.
