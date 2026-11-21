# Contracts

- No runtime API shape change.
- UI still requires:
  - durable update status `unknown`;
  - reusable SSH credential;
  - `recovery_revision`;
  - explicit checkbox review;
  - `recovery_requires_verification !== true`.
- Reconcile remains read-only and posts only the selected credential ID.
- Recovery remains explicit and posts `confirm=true` plus the reviewed `expected_revision` and selected credential ID.
