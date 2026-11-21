# Contracts

- No HTTP API shape change. `POST /machines/:id/agent-updates/:update_id/reconcile` gains one durable-state closure rule.
- Input remains admin-only and uses the existing optional credential selection.
- Closure output status is `rolled_back`.
- Receipt keeps `rollback_error_code` and adds:
  - `current_verification.boot_id`
  - `current_verification.fingerprint`
  - `current_verification.verified_at`
  - `recovery_closed_by`
- Other `rollback_failed` receipts remain `unknown` and fenced.
