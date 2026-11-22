# Contracts

- No API shape change.
- Category remains a trimmed string of at most 32 bytes without control characters; empty means uncategorized.
- Existing sessions continue to omit `category` and the UI displays them as uncategorized.
- Suggestions combine built-in defaults and categories already present in the user's sessions.
- Custom categories are user-entered and persisted only through the existing `PATCH /assistant/sessions/:id` contract.
