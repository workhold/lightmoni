# Contracts

- No center HTTP API, approval request, SSH envelope, receipt schema, or MCP contract changes.
- `POST /machines/:id/agent-updates/:update_id/recover` continues to require an administrator interaction session, confirmation, approval revision, and the exact recovery request fields.
- The local maintenance journal gains no new schema or public field. `recovery.json` remains:
  - `schema: 1`
  - `action: restore_previous`
  - `status: started | succeeded`
  - `approval`
  - `source_status`
  - `recovered_at`
- Resume accepts only `source_status` values `switching`, `waiting_confirmation`, and `rollback_failed`; all other started journals remain fenced with `recovery_interrupted`.
- Successful resume keeps the original durable recovery metadata and returns the existing update status shape after the original update reaches `rolled_back`.
