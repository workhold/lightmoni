# SDD 191 validation

## Local checks

- Node 26 with the repository lockfiles: TypeScript SDK build, Runtime type check and build, Web type check and build all passed.
- `runtime/test/platform-clusters.test.ts` and `runtime/test/managed-executor-jobs.test.ts` passed together: 135/135. After adding changed target coverage, `platform-clusters.test.ts` passed again: 99/99.
- The tests cover one automatic inspection per host, ten unchanged reconciliations without a duplicate run, a changed target recheck, queued automatic cancellation on reviewed plan creation, suppression during review, refusal for claimed and unknown work, successful two stage binding transfer, and read only unknown fence release without rewriting the unknown receipt.
- `npm run version:check` passed 46/46; `git diff --check` passed.
- The first Runtime type check failed because the TypeScript SDK distribution had not been built in the new worktree. Building that workspace dependency and rerunning resolved it; no source change was needed.

## Production

Not deployed. Issue #265 remains open until application bindings and repository inventory are actually verified. The currently running 0.1.8 center and Agent were validated in [SDD 190](../190-integrated-release-018/validation.md); this change has not yet altered production.
