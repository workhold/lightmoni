# Tasks: 主流协议与模型发现
**Input**: specs/003-multi-protocol-models/{spec,plan,research,data-model,contracts/protocols,quickstart}.md
**Tests**: Required by FR-010; native fixtures and credential/lifecycle evidence.

## Phase1 Setup
- [x] T001 Record clarified scope and validate spec/checklist in specs/003-multi-protocol-models/spec.md/checklists/requirements.md
- [x] T002 Freeze native runtime, config and catalog contract in specs/003-multi-protocol-models/contracts/protocols.md and plan/research/data-model.md
- [x] T003 Verify ignore files/checklist gate and assign backend/runtime/UI file ownership in specs/003-multi-protocol-models/plan.md

## Phase2 US2 Four actual protocols (P1)
**Independent test**: Native SDK text/tool/history/summary/cancel fixtures each pass; old blank protocol Chat remains valid.
- [x] T004 [P] [US2] Add native SDK fixture tests in ai-runtime/test/model.test.ts and/or internal/assistant/runtime_test.go
- [x] T005 [US2] Pin provider packages in ai-runtime/package.json/package-lock.json and implement factories/usage in ai-runtime/src/model.ts/protocol.ts/runner.ts
- [x] T006 [P] [US2] Add concrete protocol config enum/default/validation and bounded hidden metadata storage/public-view filtering/tests in internal/assistant/types.go/provider.go/service.go/discovery_test.go

## Phase3 US3 Automatic recommendation (P2)
**Independent test**: Auto native catalogs produce source/candidates; ambiguous OpenAI directory requires concrete choice; saved-key isolation preserved.
- [x] T007 [US3] Add native catalog/auth/auto-hint/security tests in internal/assistant/discovery_test.go
- [x] T008 [US3] Implement bounded native catalogs/recommendation/URL helpers in internal/assistant/discovery.go/provider.go
- [x] T009 [P] [US3] Add UI protocol resolution/lifecycle tests in web/src/features/assistant/model-discovery.test.mjs/model-protocol.test.mjs

## Phase4 US1 Discoverable UI (P1)
**Independent test**: Visible button,4 protocol choices, Chinese401 guidance, manual models retained and stale queries ignored.
- [x] T010 [US1] Implement protocol selector, visible fetch button and source/fallback messaging in web/src/features/assistant/ModelSettings.tsx/types.ts/model-discovery.ts/model-protocol.ts
- [x] T011 [US1] Preserve user old tab and show refreshed deliverable in new tab; evidence in specs/003-multi-protocol-models/verification.md

## Phase5 Verification
- [x] T012 Update README.md/docs/contracts.md with supported protocols and honest discovery boundaries
- [x] T013 Run runtime/native/backend/frontend checks; serialized builds and restart; record evidence in specs/003-multi-protocol-models/verification.md

## Phase6 Address repair and explicit verification (P1)
**Independent test**: auto and manual discovery follow the matrix, canonicalize a successful base, preserve manual fallback, and a concrete test request succeeds or fails with a sanitized status without persistence.
- [x] T014 Update the discovery contract and tests for auto/manual candidate matrices, canonical base adoption, fresh-key path repair and saved-key isolation.
- [x] T015 Implement bounded candidate probing for standard base/version paths without arbitrary vendor scanning or secret leakage.
- [x] T016 Add admin-only `POST /api/v1/assistant/test-connection` backed by the existing Mastra runtime; cover input validation, four protocol requests, timeout/error sanitization and no persistence.
- [x] T017 Add the UI test-connection action and copy; enable it only after a concrete protocol and model are present, and keep manual model fallback visible.
- [x] T018 Run Go, runtime and frontend verification after remote-main merge; record root-without-version, manual-protocol, and test-connection evidence.

## Dependencies/Parallel execution
T001-T003 before app edits. Backend owns internal/assistant/{types,provider,service,discovery,discovery_test}.go; runtime owns ai-runtime and optionally native runtime fixture file; UI owns web assistant settings/types/helpers/tests. Each writes meaningful tests before implementation; cross-side interfaces from contract frozen. Root handles docs, reviews and serialized final builds. Runtime package build before backend full native integration tests. Web build must not overlap Go compilation. US1/US2 ship together; US3 cannot imply generation verification.

## Implementation strategy
Complete real native adapters and transparent directory discovery in parallel, integrate visible UI, then verify native SDK behavior. Persist concrete protocols only. No real provider token spending during auto-discovery or validation.
