# Plan

1. Add fixed worker-stop and lifecycle-lock observation commands.
2. Add a guarded cleanup path to rollback-failed reconciliation after fresh original verification.
3. Re-probe the approved original and persist before/after evidence.
4. Add regressions for success, drift, live worker, and operation-lock refusal.
5. Run typecheck/build, targeted tests, release checks, and diff check.
