# Verification: 模型自动发现

Date: 2026-10-14

## Automated checks
- PASS `.local-dev/go/bin/go test -race ./...` after final saved-key fallback fix. Full log: `.local-dev/model-discovery-go-tests.log`.
- PASS `.local-dev/go/bin/go test -race ./internal/assistant`. Directory tests were added before implementation; saved-root-key regression reproduced 2 provider calls before fix and now makes only the original-path call.
- PASS `node --experimental-strip-types --test web/src/features/assistant/model-discovery.test.mjs web/src/features/assistant/assistant.test.mjs web/src/shared/assistant-context.test.mjs` (16 tests).
- PASS `npm --prefix web run typecheck` and `npm --prefix web run build`.
- PASS `.local-dev/go/bin/go build -o .local-dev/bin/lightmoni ./cmd/lightmoni` and `git diff --check`.
- Serialized frontend build and Go compilation/tests to preserve Go embedded asset input.

## Contract evidence
Fixtures verified admin-only access; invalid input before network; temporary credential precedence; encryption-at-rest and safe original-base key reuse; changed origin/scheme/path/escaped path cannot receive stored key; config PUT changed-base preservation rejected; saved root key cannot reach /v1 fallback. Discovery never changes stored config or invokes a model.
Provider fixtures cover API/custom/full-endpoint bases, root 404/405/HTML fallback, empty lists, sorted unique IDs, 500-model cap, 1MiB limit, malformed data, rate limiting, auth guidance, redirects on injected clients, network and response-read timeout, cancellation. Canonical URL tests cover case/default ports/IPv6/zone/escaped tenant path identity.
Frontend lifecycle tests cover debouncing latest credentials, invalid addresses, abort even when transport ignores cancellation, close before/after request, normalization feedback without duplicate request, explicit retry, valid empty list.

## Browser review
At 1280x720, authenticated existing admin, temporary hidden tab:
- Fixed `OpenAI 兼容 · Chat Completions` label and capability boundary visible.
- Temporary keyless fixture root at 127.0.0.1:19180 queried exactly `/models`, then `/v1/models`; no normalization feedback query.
- Two sorted unique models appeared; previously typed `manual-fixture` remained. Selected `fixture-a` from list.
- Expanded execution limits retained 32000 / 4096 / 8 and scrollable modal with visible footer.
- Unsupported custom path showed manual fallback and retained selected model.
- Cancel/reopen restored empty original configuration. No test configuration was saved, no real credential entered.
- Browser console returned no warnings/errors. Temporary tab and fixture server closed.
Local screenshot: `.local-dev/model-discovery.png` (ignored test artifact).

## Running instance and limits
Rebuilt service is running at http://127.0.0.1:8080; `/healthz` returns `{"status":"ok"}`. User pages/data/config were preserved.
No real model provider is currently configured. Fixture directory success is evidence of enumeration, not Chat Completions/tool/context compatibility. Native Responses/Anthropic remain out of scope. This enhancement added no runtime dependencies; prior Mastra dependency/deployment limitations remain documented under specs/001-mastra-assistant/verification.md.

## SDD completion
specification, requirement checklist, plan/research/data model/contracts/quickstart/tasks completed before application implementation. No extension hooks configured. Independent read-only review prompted saved-key root-fallback regression test and fix. All tasks complete; no schema migration.
