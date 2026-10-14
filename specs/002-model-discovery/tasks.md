# Tasks: 自动获取模型与明确连接协议

**Input**: specs/002-model-discovery design documents
**Prerequisites**: spec.md, plan.md, research.md, data-model.md, contracts/models.md
**Tests**: Required by FR-010. Meaningful contract and lifecycle checks.

## Phase 1: Setup
- [x] T001 Record user scope and validate requirements in specs/002-model-discovery/spec.md and checklists/requirements.md
- [x] T002 Resolve design and freeze interface in specs/002-model-discovery/plan.md, research.md, data-model.md and contracts/models.md

## Phase 2: Foundational
- [x] T003 Verify ignore files and checklist gate; coordinate backend/UI ownership using specs/002-model-discovery/contracts/models.md

## Phase 3: User Story 1 - Discover and select models
**Goal**: Retrieve model options and retain manual entry.
**Independent test**: Fixture service yields options, root fallback normalizes API base, manual model remains unchanged, no storage changes.
- [x] T004 [P] [US1] Add provider directory/path/limit/error contract tests in internal/assistant/discovery_test.go
- [x] T005 [P] [US1] Add input/debounce/cancellation/stale result tests in web/src/features/assistant/model-discovery.test.mjs
- [x] T006 [US1] Implement bounded directory retrieval in internal/assistant/discovery.go and shared URL helpers in provider.go
- [x] T007 [P] [US1] Implement automatic discovery and manual model entry in web/src/features/assistant/ModelSettings.tsx and model-discovery.ts; integrate AssistantPage.tsx/types.ts

## Phase 4: User Story 3 - Protect credentials (P1)
**Goal**: Existing key usable only at original endpoint; no member access.
**Independent test**: Member and changed-base requests contact provider zero times; saved key reuse/clear/new key behaves correctly.
- [x] T008 [US3] Add authorization/encryption/reuse/save-boundary tests in internal/assistant/discovery_test.go
- [x] T009 [US3] Register authenticated admin endpoint and protect config PUT in internal/assistant/service.go

## Phase 5: User Story 2 - Show protocol
**Goal**: Explicitly show current Chat Completions protocol without claiming capabilities.
**Independent test**: Configuration/API/UI show fixed protocol; discovery does not set limits/model capabilities.
- [x] T010 [US2] Add fixed protocol to ConfigView in internal/assistant/types.go/service.go and UI explanation in web/src/features/assistant/ModelSettings.tsx/types.ts

## Phase 6: Polish and validation
- [x] T011 Update operator contract in docs/contracts.md and README.md
- [x] T012 Run backend race tests, frontend helper tests/typecheck/build and service restart; record browser/fixture evidence in specs/002-model-discovery/verification.md

## Dependencies and parallel work
T001-T003 before application edits. Backend T004 -> T006 -> T008 -> T009/T010, and frontend T005 -> T007/T010 can proceed in parallel because file ownership is separate. T011-T012 after both sides integrate. US1 and US3 ship together because key isolation is a credential boundary. US2 uses independent fixed-protocol field with no runtime changes.

## Implementation strategy
Deliver safe discovery with manual fallback first, then verify key protection and explicit protocol display. Frontend never persists discovery values itself; explicit Save remains authoritative. No native provider expansion.
