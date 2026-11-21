# Contracts

- No public API contract changes.
- Confirmed mutating handlers may return after the browser disconnects, but must continue using a center-owned bounded `operationSignal`.
- `operationSignal` is a 15 minute hard center-session bound; remote systemd timeouts and maintenance budgets remain the authoritative execution limits.
- Request `AbortSignal` remains valid for read-only probes, planning, downloads, and interactive reconciliation.
- Durable operation rows remain authoritative. Browser disconnect and center restart never auto-approve replay; they either let the detached operation finish safely or move the record to the existing verified recovery flow.
