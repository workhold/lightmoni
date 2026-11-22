# Plan

1. Add an owner-scoped category rename endpoint that batches session updates and skips active turns.
2. Extend the manager rows with a rename action and confirmation input.
3. Update local session state only for non-skipped sessions; show merge and skip feedback.
4. Keep renamed fixed suggestions visible through user-scoped browser-local custom suggestions.
5. Extend browser fixture for backend rename, local suggestion persistence, and manager UI.
