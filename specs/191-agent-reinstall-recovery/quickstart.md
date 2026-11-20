# Validation guide

1. Build Runtime and run targeted platform cluster and privileged executor tests. Confirm one automatic inspection per host, stable retained container status, queued automatic cancellation on plan creation, and unchanged unknown job audit.
2. Run Runtime and Web type checks/build, `git diff --check`, and `npm run version:check`.
3. In isolation, create a host with new Agent and old instances. Generate and approve a reviewed plan; confirm original instance IDs, ports, and data paths remain while Agent bindings move.
4. Before production rollout, identify the fixed image revision and preserve the existing Compose, state, telemetry, and secret backups. Change only the center image reference and verify center and ClickHouse health.
5. On `zz-bj-1`, use the existing administrator review workflow. Record both checks and the approval receipt. Verify the four application management states and private repository image list separately from container health.
