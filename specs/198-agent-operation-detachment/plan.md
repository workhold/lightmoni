# Plan

1. Add a bounded center-owned operation signal for confirmed host mutations.
2. Use it for Agent installation SSH/readiness, destructive uninstall, update start/apply, and update recovery.
3. Preserve request cancellation for read-only planning, probes, downloads, and reconciliation.
4. Update the operation lifecycle regression to prove request disconnect leaves detached installation running.
5. Run targeted regressions, typecheck/build, version check, and diff checks.
