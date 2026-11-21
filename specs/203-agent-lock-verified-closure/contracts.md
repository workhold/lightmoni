# Contracts

- No public API shape change. The existing reconcile endpoint gains one narrowly guarded lock-cleanup rule.
- Trigger conditions:
  - durable update status is `unknown`;
  - durable receipt is `rollback_failed`;
  - `rollback_error_code=recovery_original_unhealthy`;
  - fresh probe matches the approved original exactly;
  - worker unit/cgroup/processes are stopped;
  - only the lifecycle lock remains.
- Cleanup executes a fixed remote command bounded to `/run/lightmoni-agent-lifecycle.lock`; it must not touch `/run/lightmoni-agent` operation state, task markers, queues, or service files.
- Receipt records `lifecycle_lock_cleanup` with before/after probe fingerprints and verified worker evidence.
