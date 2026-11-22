# Contracts

## PATCH /api/v1/assistant/categories/:category

Authenticated and owner-scoped.

Request:

```json
{ "category": "云监控" }
```

Response:

```json
{
  "category": "监控",
  "new_category": "云监控",
  "updated_count": 2,
  "skipped_count": 1,
  "skipped_session_ids": ["f1c0"]
}
```

- Old and new values are trimmed, non-empty, at most 32 bytes, and contain no control characters.
- If the new category already exists, matching sessions are merged into it.
- Sessions with active assistant turns are skipped.
- Only `category` and `updated_at` change; conversations, messages, and attachments remain.
- Updatable writes run in one transaction.
