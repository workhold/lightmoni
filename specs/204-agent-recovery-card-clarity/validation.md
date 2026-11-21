# Validation

- `npm --prefix web run typecheck` passed.
- `npm --prefix web run build` passed.
- Web component SSR regression passed 2/2 (`agent-update-recovery-card.test.mjs`).
- Local browser preview verified the locked recovery state at 1440px: the card shows one primary read-only verification action, a disabled reviewed-recovery action, concise lock guidance, and folded recovery impact.
- `git diff --check` passed.
- Release version consistency passed for the pending `0.1.12` release branch (46/46).

Pending production validation:

- Reopen the saved `vchive` unknown maintenance record and verify the new card appears.
- Reconcile once through the new card and read back the durable terminal state.
