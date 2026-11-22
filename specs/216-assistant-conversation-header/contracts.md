# Contracts

No API contract change. Existing `PATCH /assistant/sessions/:id` continues to accept optional `title` and `category`. The UI may send either field; titles remain trimmed, non-empty, and bounded to 240 bytes by the server. Categories retain existing 32-byte validation.
