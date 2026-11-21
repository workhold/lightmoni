# Contracts

- `POST /api/v1/assistant/sessions` accepts optional `category`; empty/missing is uncategorized.
- `PATCH /api/v1/assistant/sessions/:id` accepts optional `title` and/or `category`; rejected while active.
- `DELETE /api/v1/assistant/sessions/:id` is owner-only and rejected while active; returns `{deleted:true}`.
- `GET /api/v1/assistant/sessions` always exposes `category` as a trimmed string.
- Category length is at most 32 bytes, control characters rejected.
- Deletion removes the session KV record and all `attachment/<user>/<session>/` records.
