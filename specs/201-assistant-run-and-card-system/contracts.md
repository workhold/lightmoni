# Contracts

- No public HTTP contract change; the existing turn endpoint remains SSE and cancel endpoint remains explicit.
- Turn execution signal is composed only of the internal cancel controller and bounded model timeout, never the request signal.
- SSE responses remain best-effort transport; events, messages, checkpoints, and usage remain durable authority.
- Browser route unmount must not abort active turn fetches. `sessionStorage` only restores the most recent UI selection and is not the conversation authority.
- All tool/result cards consume the shared assistant card CSS grammar. Statuses map to `running`, `success`, `failed`, and `cancelled`.
