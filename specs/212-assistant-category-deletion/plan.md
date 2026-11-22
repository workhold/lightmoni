# Plan

1. Add an owner-scoped assistant endpoint that clears one category across sessions and skips active turns.
2. Add a dedicated category manager modal beside the new-conversation category field.
3. Keep hidden fixed suggestions in browser-local UI state keyed by user.
4. Confirm deletion impact before calling the API; show partial-skip feedback.
5. Add a browser fixture for manager deletion, session clearing, and suggestion persistence.
