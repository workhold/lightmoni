# Validation

- Runtime assistant suite: `npm --prefix runtime run test -- assistant.test.ts` passed 20/20, including explicit cancellation, pending-tool cancellation, checkpoint durability, and usage accounting.
- Root web typecheck/build: `npm --prefix web run typecheck` and `npm --prefix web run build` passed.
- Runtime typecheck/build: `npm --prefix runtime run typecheck` and `npm --prefix runtime run build` passed.
- Release identity: `npm run version:check` passed 46/46 for `0.1.10`.
- `git diff --check` passed.
- The conversation browser verifier remains blocked by an existing detached Ant Design action button during queue interaction; it is unrelated to this control-path change and must be fixed separately before production UI sign-off.
- Existing local tests for Agent update progress rendering and full platform Runtime suites also fail in this workspace for missing generated release artifacts/native fixture mismatches; targeted production-relevant checks above are the evidence for this PR.

Pending production evidence:

- Deploy an image containing this change.
- Start a turn, navigate away, and reopen the assistant while the session is running; verify the durable session remains running, polls progress, and completes rather than showing `request cancelled`.
- Verify explicit stop still cancels the turn and emits the normal cancelled event.
