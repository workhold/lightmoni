# SDD 191 validation

## Local checks

- Node 26 with the repository lockfiles: TypeScript SDK build, Runtime type check and build, Web type check and build all passed.
- `runtime/test/platform-clusters.test.ts` and `runtime/test/managed-executor-jobs.test.ts` passed together: 135/135. After adding changed target coverage, `platform-clusters.test.ts` passed again: 99/99.
- The tests cover one automatic inspection per host, ten unchanged reconciliations without a duplicate run, a changed target recheck, queued automatic cancellation on reviewed plan creation, suppression during review, refusal for claimed and unknown work, successful two stage binding transfer, and read only unknown fence release without rewriting the unknown receipt.
- `npm run version:check` passed 46/46; `git diff --check` passed.
- The first Runtime type check failed because the TypeScript SDK distribution had not been built in the new worktree. Building that workspace dependency and rerunning resolved it; no source change was needed.

## Image publication and isolation

- PR [#266](https://github.com/workhold/lightmoni/pull/266) merged the fix and architecture update to GitHub `main@b9686762ac97637abff9f2cd37d1c33208c4bd80`.
- Built linux/amd64 image `v0.1.8-20261120-213716-amd64` from that exact checkout. Local image metadata reports OCI revision `b9686762ac97637abff9f2cd37d1c33208c4bd80`, platform linux/amd64 and user `lightmoni`. Node, npm, and Debian mirrors accelerated downloads without disabling lockfile integrity, Node hash, or Debian signature checks.
- The image's Linux amd64/arm64 Agent archives and Go, Python, Rust, and TypeScript SDK packages passed `SHA256SUMS` and `SDK_SHA256SUMS` checks.
- An isolated Compose project using the new image and disposable volumes started with both LightMoni and ClickHouse healthy. ClickHouse `SELECT 1` returned `1`; homepage and `/healthz` returned HTTP 200, and the unauthenticated operations endpoint returned HTTP 401. The running container's OCI revision matched `main@b9686762`. The isolated containers, network, volumes, and temporary credential file were removed.
- Pushed the fixed tag and `latest`; remote readback for both is `sha256:92aadaeeb13f9f6855367562640d5cb51f5ce10653077bcdf706a0f94741e9c1`. The business manifest is linux/amd64. Pulling the fixed tag again returned the same digest.

## Production

Not deployed. Issue #265 remains open until application bindings and repository inventory are actually verified. The currently running first 0.1.8 center and Agent were validated in [SDD 190](../190-integrated-release-018/validation.md); this new center image has not yet altered production.
