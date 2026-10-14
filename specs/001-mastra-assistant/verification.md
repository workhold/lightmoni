# Verification — 2026-10-14

## Completed acceptance

| Requirement / story | Evidence | Result |
| --- | --- | --- |
| US1 / FR-001–004 | Actual Mastra worker fixture runs catalog → schema → host query → draft → final answer; source history has complete exchanges and draft receipt saved:false/requires_review:true | PASS |
| US1 / FR-004 | Host SQLite ownership/encryption tests, unknown-tool worker test, registered-tool write rejection and common query AST tests | PASS |
| US2 / FR-005–006 | Complete-round budget tests, actual tool-free summary fixture, failed-summary source preservation and cancellation during summary without prefix commit | PASS |
| US3 / FR-007 | Actual raw provider counts survive host reload; absent usage stays absent; UI replay sums phases without double counting | PASS |
| US3 / FR-008 | Active worker cancelled under 3 seconds; per-session and instance slots released, subsequent turn succeeds; busy response does not mutate the other session | PASS |
| FR-009 | Adjacent durable deltas coalesced, 250ms persistence; final checkpoints and terminal events immediately persisted; history/timeline replay tests | PASS |
| FR-010 | Default/invalid settings tests, actual step/output-limit fixtures, model budget rechecked after oversized tool output, Node worker shipped in Dockerfile | PASS for code/local runtime; image build unverified |
| FR-011 | Provider error fixture body contains a fake credential; worker emits only fixed error codes, key absent from public config/errors; private stdin transport and discarded stderr | PASS |

## Commands

- `npm --prefix ai-runtime run build`: PASS.
- `npm --prefix ai-runtime run typecheck`: PASS.
- `npm --prefix ai-runtime test`: PASS, 3 context tests.
- `go test -race ./...`: PASS after web build completed. Initial attempt overlapped Vite clearing Go embed assets; corrected to serial build/test order.
- `go test -race ./internal/assistant`: PASS after the final summary-cancellation regression test was added.
- `node --experimental-strip-types --test web/src/features/assistant/assistant.test.mjs web/src/shared/assistant-context.test.mjs`: PASS, 11 tests.
- `npm --prefix web run typecheck` and `npm --prefix web run build`: PASS. Existing bundler directive/chunk-size warnings remain.
- `go build ./cmd/lightmoni`: PASS; rebuilt local binary started with existing SQLite and ClickHouse.
- `git diff --check`: PASS.
- `GET http://127.0.0.1:8080/healthz`: `{status:ok}`.
- Browser inspection of `/assistant`: existing authenticated user/session preserved, unconfigured-model state displayed, limits 32000/4096/8 shown. Expanded settings scroll within modal while Cancel/Save stay visible at 1280×720. No user configuration was saved during inspection.

## Practical limits

- The current user instance has no model configured. No real provider key was imported or used. Fixtures verify actual Mastra integration and control boundaries, not diagnostic quality or real provider compatibility.
- Docker is not installed on this machine. Multi-stage Dockerfile includes the official Node 24 runtime, compiled worker and production dependencies, but the image build/Compose acceptance is not verified.
- Input allowance is a conservative UTF-8 byte estimate. Entire older rounds are summarized in bounded batches; a single round too large for summarization fails explicitly. Original source history remains subject to the existing 2 MiB session storage limit. No background auto-resume is promised.
- `npm audit --omit=dev` reports 5 moderate transitive advisories through Mastra/gray-matter/js-yaml/argparse/sprintf-js. The recommended automatic change downgrades Mastra to 1.0.4, incompatible with the selected APIs; no force downgrade was applied. Locked dependency review remains necessary before production release.
- Doca current AGPL code was inspected as architecture reference. No current Doca implementation source was copied into this migration.
