# Plan

1. Extend read-only worker evidence to verify unit state, PID fields, and systemd cgroup emptiness.
2. Require the same evidence before guarded lifecycle-lock cleanup during reconcile.
3. Add regression coverage for residual empty cgroup and populated cgroup refusal.
4. Run runtime targeted tests, project build, version checks, and diff checks.
