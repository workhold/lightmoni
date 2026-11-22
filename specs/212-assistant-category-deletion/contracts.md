# Contracts

## DELETE /api/v1/assistant/categories/:category

Authenticated, owner-scoped. `category` is the exact trimmed category value. The category must be non-empty, at most 32 bytes, and contain no control characters.

Response:

```json
{
  "category": "客户系统",
  "updated_count": 2,
  "skipped_count": 1,
  "skipped_session_ids": ["f1c0"]
}
```

- `updated_count`: sessions whose category was cleared.
- `skipped_count`: sessions with active assistant turns left untouched.
- Sessions are not deleted; only `category` becomes `""`.
- The write is transactional for updatable sessions.
