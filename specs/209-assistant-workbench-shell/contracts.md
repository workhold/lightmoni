# Contracts

- No public API shape change.
- Inspector data is projected client-side from already authorized `GET /assistant/sessions/:id` events.
- Artifact actions may only reuse existing read-only navigation or review flows:
  - SQL: show SQL and invoke the existing `onSQL` callback;
  - Dashboard: open the existing review modal;
  - Code task: navigate/read through the existing code-task card and explicit apply;
  - Agent/install plans: open existing persisted `review_url`;
  - SSH checks: render existing authorized read-only summary.
- Inspector never presents model text as execution success.
- Unknown, failed, or cancelled tool states remain visible.
