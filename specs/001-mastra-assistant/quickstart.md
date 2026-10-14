# Development and acceptance

1. npm --prefix ai-runtime ci && npm --prefix ai-runtime run build
2. npm --prefix web ci && npm --prefix web run build
3. Start ClickHouse per README, then LIGHTMONI_EXTERNAL_URL=http://127.0.0.1:8080 go run ./cmd/lightmoni from repository root. Worker defaults to ai-runtime/dist/runner.js and node on PATH.
4. Log in and set an explicit model endpoint/name/key in AI settings. No credentials are imported from Doca.
5. Ask to inspect tables, then generate a dashboard. Confirm receipts and unsaved draft, preview and save through normal editor.
6. npm --prefix ai-runtime test; go test -race ./internal/assistant; npm --prefix web run typecheck. Actual worker integration fixture runs without provider credentials and verifies tool history, summary, reported usage, malformed calls, errors and cancellation.

Production Dockerfile ships Node and worker in the same image; LIGHTMONI_AI_RUNNER points to /opt/lightmoni-ai/dist/runner.js. Runtime errors should leave normal Go monitoring routes operational. True provider/model quality is a separate manual acceptance.
