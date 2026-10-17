# Agent migration validation

Date: 2026-10-17. Validation host: macOS arm64, local Node 22.23.1 (baseline) and 24.15.0 (final), with the
repository's development Go toolchain. Tests use temporary data directories,
synthetic identities/keys and loopback mock endpoints. The running service on
port 8080 and its real queue/configuration were not used or modified.

## Durable spool and wire compatibility

- Before removing the Go implementation, a real Go → Node → Go round-trip
  passed: Go accepted OTLP JSON into its SQLite spool, Node reopened it without
  migration, preserved the identity and nanosecond timestamps, replayed the exact
  frozen forwarding bytes, deduplicated retries and completed the batch. Go then
  reopened the Node-written spool and confirmed the same identity and no pending
  batch. The Agent/OTLP suite at that point passed 21 tests, without skips.
- `runtime/test/fixtures/go-agent-spool.json` retains the old Agent's actual
  schema, typed integer rows, original incoming payloads, frozen protobuf BLOBs,
  synthetic persistent identity, a twice-retried pending batch and a completed
  receipt. It was generated from baseline commit
  `1d892c9e00005d497cfbc8660a5dd67b22d4da29`. The static restoration test also
  verifies an exact int64 log cursor, binary prefix and Node reopen/deduplication.
  It needs neither the deleted Go implementation nor a Go compiler.
- The remaining OTLP differential tests use only standard public Go protobuf
  packages. Deterministic serialization and input hashes match Go for all three
  signals; nested unknown fields, duplicate message tags, explicit oneof zero,
  optional zero, int64/uint64 extremes, exact numeric exponents and NaN payload
  bits are covered. No Go executable is used by production Node code.
- Agent receiver tests exercise durable ACK ordering, local authentication,
  gzip/plain size limits, queue/receipt capacity, injected SQLite failures,
  lost upstream ACKs, exact frozen-byte retries, rotated keys and quarantine
  after partial success. File log tests cover offset/queue transactionality,
  rotation, truncation, restart, incomplete lines, UTF-8 fragments and symlinks.
- Control, assigned-task withdrawal, SDK configuration offline caching, actual
  local host reads, local HTTP/TCP probes and CLI configuration/discard behavior
  are covered by the 12 passing Agent cases.

## Business SDK integration

`sdk/go/agent_integration_test.go` launches the actual TypeScript Agent receiver
through `runtime/test/helpers/sdk-agent.ts`, using an isolated temporary spool.
The Go SDK and TypeScript example send logs, metrics and spans. The receiver is
stopped, its persisted spool is reopened, and the original protobuf payloads are
returned to the Go test. Assertions passed for six durable batches, independent
counter totals of 2 and 3, valid trace/span IDs and matching log/span trace IDs.
The complete `go test ./sdk/go -count=1` suite also passed.

The existing opt-in six-language Docker SDK test uses the same Node helper and
retains its 18-batch, six-language counter/log/span assertions. It was not run in
this macOS validation session; enabling it still requires
`LIGHTMONI_NATIVE_SDK_TEST=1` and the native SDK Docker test prerequisites.

## Center compatibility at the Agent boundary

The four `ingest-compat.test.ts` cases pass against static expected values
created by Go, including trace event/link JSON field shapes, exact integers,
Go decimal rounding ties, SDK revision hashing, struct field order, map sorting,
default/omitted values and HTML escapes. Failed ingest metadata insertion or
completion returns 503 and preserves the event ID on replay; gzip expansion over
4 MiB returns 413 and corrupt gzip is rejected.

## Installer transaction and rollback

`runtime/test/install-release.test.ts` executes the real `/bin/sh` installer.
Every writable absolute destination is rewritten to one temporary test root;
command shims provide root/Linux/systemd/install/mv/checksum behavior, and the
fixture supplies a fake bundled Node executable and launcher. No command writes
into the host's `/etc`, `/opt`, `/usr/local/bin` or `/var/lib`.

All six installer scenarios passed:

1. Checksum mismatch leaves the old release, service, configuration, queue and
   identity unchanged and does not call systemctl.
2. A verified release switches the runtime symlink, configures/restarts the
   service, retains the old runtime directory and preserves spool/identity bytes.
3. Restart failure restores an earlier Node launcher/current symlink, config,
   service contents and permissions, then restarts the previously active service.
4. Restart failure also restores an earlier standalone Go executable and removes
   the newly introduced Node runtime symlink.
5. An installation that began with an inactive service leaves it inactive after
   rollback; it does not restart the old service.
6. First-install restart failure removes newly installed live files, disables the
   newly enabled service and exits unsuccessfully without printing success.

Configuration is prepared and checked in a temporary file before replacing live
files. Rollback retains backup files and emits their location if restoration
itself fails. Agent queue, identity, log cursors and cached tasks are never
opened by configure/check or rewritten by the installer.

`sh -n` passes for installer, launcher and uninstaller. `git diff --check` passes.
At the recorded full-suite run, runtime typecheck passed and 110 tests produced
108 passes, two opt-in live integration skips and zero failures. Additional
release/live acceptance results are recorded by the integration owner after the
final bundle build.

## Release platform and limits of this validation

Release targets are **Linux amd64 and Linux arm64, glibc >= 2.28**. The builder
pins bundled Node **24.15.0**, verifies upstream SHA256, checks ELF architecture,
includes the compiled Agent/SDK and production dependencies, validates portable
relative dependency links and writes SHA256SUMS. No global Node/npm is required
on the destination machine.

The initial package audit found absolute dependency symlinks pointing into the
removed macOS staging directory. This was a real packaging defect; the release
owner corrected preservation/validation of relative symlinks and rebuilt both
archives. The final opt-in archive test passed on Node 24.15.0 for both architectures.
It also caught and fixed CLI entry detection through the installed current-release
symlink; canonical real paths are compared before executing the CLI. `runtime/test/release-live.test.ts` provides the opt-in final
archive verification with `LIGHTMONI_RELEASE_DIR`: SHA256, ELF architecture,
relative dependency links and extracted JavaScript CLI execution using the host
Node.

Building both Linux architectures, inspecting ELF headers, running extracted
JavaScript with macOS Node, and the shim installer tests **do not demonstrate
execution of the Linux Node binaries or a real Linux systemd installation**.
This macOS session did not perform a Linux boot/startup, architecture-specific
host collector run or real service upgrade/rollback. Those remain Linux
acceptance checks, and Alpine/musl is outside the glibc release target.
