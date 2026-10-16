# Verification: 主流模型协议与可见模型发现

Date: 2026-10-16

## Automated checks
- PASS `npm --prefix ai-runtime run typecheck`, `npm --prefix ai-runtime run build`, `npm --prefix ai-runtime test` (28/28).
- PASS `node --experimental-strip-types --test web/src/features/assistant/model-discovery.test.mjs web/src/features/assistant/model-protocol.test.mjs web/src/features/assistant/assistant.test.mjs web/src/shared/assistant-context.test.mjs` (25/25).
- PASS `npm --prefix web run typecheck`.
- PASS `.local-dev/go/bin/go test -race ./...` after final backend credential hardening; log `.local-dev/multi-protocol-go-tests.log`.
- PASS final `.local-dev/go/bin/go test -race ./internal/assistant` (7.278s), including explicit continuation-state error mapping; log `.local-dev/multi-protocol-assistant-tests.log`.
- PASS `npm --prefix web run build`, then `.local-dev/go/bin/go build -o .local-dev/bin/lightmoni ./cmd/lightmoni`; serialized so Go embedded assets are stable. Vite emits existing dependency directive warnings; build succeeds.
- PASS `git diff --check`; rebuilt local service `/healthz` returns status:ok.

## Native runtime evidence
Real pinned SDKs and Mastra connect to isolated local fixture servers. All four protocols verify native endpoint/header/body, streamed text, tool call/result continuation, fresh-worker history replay, generation-based history summary, provider-error redaction and cancellation. Chat/Responses/Gemini missing raw usage stays unknown; Anthropic cache input and Gemini thought output count mappings have direct tests. Custom versioned paths remain intact. Responses explicitly sends store:false and requests reasoning.encrypted_content even for unknown model aliases.
Gemini tool signatures and visible-text signatures retain their original native association across a second fresh worker; Responses reasoning ciphertext/item IDs survive both continuation and fresh worker. Hidden reasoning plaintext is excluded. Opaque oversize fails explicitly; metadata counts in context estimates and is omitted from summary prose.

## Discovery and credential boundaries
Discovery is read-only and never issues generation probes. Unknown OpenAI-compatible catalogs require a concrete Chat/Responses choice. Official domains, complete endpoint paths and native catalog envelopes provide recommendations, not a capability claim. Saved keys stay on the exact canonical base and never use version-path fallback. Independent review checks credential-error priority, escaped-path identity and opaque checkpoint boundaries.

## Existing user page
The old tab at /assistant was inspected and still contained the previous production bundle, without discovery controls. It also had an unsaved password field, so the tab was preserved without reloading, closing or extracting its key. A fresh production page is delivered after serialized build/restart.
The supplied Huayan URL was probed only by unauthenticated GET /v1/models and returned401. This confirms a valid key is required for enumeration; it does not identify the generation protocol or verify actual vendor compatibility. No real key was read and no external model generation occurred.

## Limits
Local fixtures validate our wire contracts and lifecycle; real provider/model quality and custom proxy support remain unverified until the user configures valid credentials. Docker deployment was not rerun for this change; prior runtime/dependency limitations remain recorded in specs/001-mastra-assistant/verification.md.

## Browser verification and delivery
Fresh authenticated tab8, final compiled production bundle at http://127.0.0.1:8080/assistant, normal1300x821 viewport:
- Standalone large 获取模型 button and auto plus four concrete protocol options visibly present.
- Keyless local directory fixture root queried exactly /models404 then /v1/models200, with no normalization feedback query; sorted/deduplicated two models and previously typed manual-fixture preserved.
- Auto shared OpenAI catalog required concrete Chat/Responses choice; clicking save stayed in form with actionable validation and did not save. Manual Responses query returned its explicit source.
- Native Anthropic envelope auto suggested Messages; native Gemini envelope auto suggested Gemini, stripped models/ prefix and excluded explicit embed-only entry; gemini-fixture was selectable.
- Local401 showed Chinese credential guidance; unsupported custom directory showed manual fallback and retained selected model. Execution limits remained32000/4096/8; modal scrolls with footer available.
- Cancel/reopen restored empty original configuration: no test configuration was persisted, no session created, no real credential entered.
- Final fresh tab contains the supplied Huayan address and auto protocol, with empty Key. Read-only actual directory request without Key showed credential rejection. Existing tab5 remains preserved with its unsaved inputs; Key was never extracted.
- Browser console warnings/errors empty. Temporary fixture server stopped; final tab marked deliverable and shown. Screenshots: .local-dev/multi-protocol-models.png (all protocol choices), .local-dev/multi-protocol-models-ready.png (supplied address and visible fetch button).

## SDD completion
All T001–T013 complete. Spec/checklist/plan/research/data-model/contracts/tasks preceded implementation; native continuation requirement was documented before its cross-layer edits. Independent review drove credential-error precedence and escaped-key echo regressions. No SQLite migration; source user data/config preserved.

## Phase 6 address repair and explicit connection verification
- PASS fresh-key root discovery probes `/models` then the same-origin `/v1/models` candidate, returns the successful canonical Base URL, and preserves 401/403 as credential errors when all candidates fail.
- PASS automatic discovery keeps profile candidates separate so Google can use `/v1beta/models`; manual protocol mode probes only the selected profile; saved-key mode never crosses the exact canonical Base URL.
- PASS admin-only `POST /api/v1/assistant/test-connection` validates concrete protocol/model input, exercises all four protocol configurations through the Mastra runtime fixture, maps timeout/provider failures to safe statuses, and does not persist a config or session.
- PASS `npm --prefix ai-runtime run typecheck`, `npm --prefix ai-runtime test` (28/28), `node --experimental-strip-types --test web/src/features/assistant/model-discovery.test.mjs web/src/features/assistant/model-protocol.test.mjs web/src/features/assistant/assistant.test.mjs web/src/shared/assistant-context.test.mjs` (25/25), `npm --prefix web run typecheck`, `npm --prefix web run build`, `.local-dev/go/bin/go test ./...`, `.local-dev/go/bin/go test -race ./...`, `.local-dev/go/bin/go build -o .local-dev/bin/lightmoni ./cmd/lightmoni`, and `git diff --check`.
- Directory refresh remains read-only; the UI keeps manual model entry available and only the explicit test action can create a provider generation request. No production provider key or generation request was used during verification.
