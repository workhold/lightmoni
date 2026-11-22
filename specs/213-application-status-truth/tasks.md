# Tasks

- [x] T001 Implement late read-only receipt acceptance in `runtime/src/server/agent-jobs.ts` (keep lease on unknown sweep; accept original-lease terminal receipts for `.inspect`/`.logs` within 10 minutes; audit event).
- [x] T002 Implement automatic read-only verification of unknown instances: registry `reconcile()` dispatches verify inspect with cooldown instead of returning blocked; capability split keeps legacy agents on the tick path.
- [x] T003 Implement infrastructure-error preservation in the run-receipt subscriber (fall back to the last verified observation for `operation_command_timeout`, `operation_dependency_unavailable`, `docker_permission_denied`, `docker_daemon_unavailable`).
- [x] T004 Widen default HTTP probe success to 2xx+3xx in `runtime/src/operations/platform.ts`.
- [x] T005 Add regression tests for the four acceptance scenarios; each fails on unfixed code (reverse-verified via stash).
- [x] T006 Update `docs/system-design.md` (chapter 93 health defaults + new chapter 213).
- [x] T007 Run focused + full runtime tests and typecheck; record evidence in validation.md.
