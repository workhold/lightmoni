# Validation guide

From repo root:
```sh
.local-dev/go/bin/go test -race ./internal/assistant
node --experimental-strip-types --test web/src/features/assistant/model-discovery.test.mjs web/src/features/assistant/assistant.test.mjs web/src/shared/assistant-context.test.mjs
npm --prefix web run typecheck
npm --prefix web run build
.local-dev/go/bin/go build -o .local-dev/bin/lightmoni ./cmd/lightmoni
```
Build frontend before Go build (embedded assets); do not run Vite build concurrently with Go compilation/tests. Restart local server and reload /assistant.

Use isolated provider fixtures, never personal credentials. Verify normal, root-fallback and full-endpoint inputs; manual input when directory fails/empty; unchanged model selection; canceled/stale requests; unchanged stored config; saved key reused only at same base; changed base and member requests make zero provider calls. Browser review at 1280x720: protocol visible, password masked, searchable model field and scrollable limits. No live provider capability claim without real configured service.
