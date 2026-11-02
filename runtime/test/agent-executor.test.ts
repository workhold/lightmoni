import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, chmodSync, chownSync, writeFileSync, readFileSync, existsSync, realpathSync, symlinkSync, readlinkSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { digest } from "../src/agent/config.js";
import { CapabilityExecutor } from "../src/agent/executor.js";

const linuxRoot = process.platform === "linux" && process.geteuid?.() === 0;

function releaseBundle(overrides: { service_id: string; version: string; architecture: "any" | "linux-amd64" | "linux-arm64" }, extras: Array<{ name: string; content: Buffer; mode: number }> = []) {
  const entries = [
    { name: "manifest.json", content: Buffer.from(JSON.stringify({
      schema_version: 1, ...overrides, source_revision: "git:0123456789abcdef", entrypoint: "run",
    })), mode: 0o644 },
    { name: "run", content: Buffer.from("#!/bin/sh\necho hello\n"), mode: 0o755 },
    ...extras,
  ];
  const blocks = entries.map(({ name, content, mode }) => {
    const header = Buffer.alloc(512);
    header.write(name, 0, "utf8");
    header.write(mode.toString(8).padStart(7, "0") + "\0", 100, "ascii");
    header.write("0000000\0", 108, "ascii");
    header.write("0000000\0", 116, "ascii");
    header.write(content.length.toString(8).padStart(11, "0") + "\0", 124, "ascii");
    header.write("00000000000\0", 136, "ascii");
    header.fill(0x20, 148, 156);
    header[156] = 0x30;
    Buffer.from("ustar\0", "binary").copy(header, 257);
    header.write("00", 263, "ascii");
    const checksumValue = header.reduce((sum, byte) => sum + byte, 0);
    header.write(checksumValue.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
    const padding = Buffer.alloc((512 - content.length % 512) % 512);
    return [header, content, padding];
  });
  return gzipSync(Buffer.concat([...blocks.flat(), Buffer.alloc(1024)]));
}

function systemdOutput(releaseDirectory: string, options: { loadState?: string; activeState?: string; unitFileState?: string; execStart?: string } = {}) {
  const expected = join(releaseDirectory, "current", "run");
  return [
    `LoadState=${options.loadState ?? "loaded"}`,
    `ActiveState=${options.activeState ?? "active"}`,
    `UnitFileState=${options.unitFileState ?? "enabled"}`,
    `ExecStart=${options.execStart ?? `{ path=${expected} ; argv[]=${expected} ; ignore_errors=no ; start_time=[n/a] ; stop_time=[n/a] ; pid=0 ; code=(null) ; status=0/0 }`}`,
    "",
  ].join("\n");
}

function makeReleaseRoot(path: string) {
  mkdirSync(path, { recursive: true });
  chmodSync(path, 0o755);
}

test("capability executor stages matching digest and atomically activates release", { skip: !linuxRoot }, async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "lightmoni-executor-"));
  const release = join(root, "service"), version = "v1";
  makeReleaseRoot(release);
  const bytes = releaseBundle({ service_id: "a".repeat(32), version, architecture: process.arch === "arm64" ? "linux-arm64" : "linux-amd64" });
  const digestValue = digest(bytes);
  const executor = new CapabilityExecutor({
    now: () => new Date("2026-10-22T00:00:00Z"),
    command: async () => ({ stdout: "", stderr: "" }),
    downloadArtifact: async (action) => { assert.equal(action.release_id, "release_1"); return bytes; },
  });
  const result = await executor.execute({
    id: "job", expires_at: "2026-10-22T00:10:00Z", capabilities: ["artifact.stage", "artifact.activate_release"],
    target: { releaseDirectory: release, unit: "checkout.service" },
    actions: [
      { kind: "stage_artifact", release_id: "release_1", service_id: "a".repeat(32), version, architecture: process.arch === "arm64" ? "linux-arm64" : "linux-amd64", destination: "releases/v1", sha256: digestValue, size: bytes.length },
      { kind: "activate_release", releaseDirectory: release, version, expectedCurrentVersion: "" },
    ],
  });
  assert.equal(result.state, "succeeded");
  assert.equal(readlinkSync(join(release, "current")), "releases/v1");
  assert.equal(readFileSync(join(release, "current", "run"), "utf8"), "#!/bin/sh\necho hello\n");
  assert.equal(statSync(join(release, "releases", "v1", "run")).mode & 0o005, 0o005);
  assert.equal(statSync(join(release, "releases", "v1", "run")).mode & 0o222, 0);
  assert.equal(statSync(join(release, "releases", "v1", "manifest.json")).mode & 0o004, 0o004);
  assert.equal(statSync(join(release, "releases", "v1")).mode & 0o005, 0o005);
  assert.equal(statSync(join(release, "releases")).mode & 0o001, 0o001);
  assert.deepEqual(result.snapshot, {
    release_id: "release_1", staged_version: version, staged_path: "releases/v1", sha256: digestValue, size: bytes.length,
    previous_version: "", current_version: version,
  });
});

test("capability executor rejects bad digest, path escape, unit mismatch and unknown capability", { skip: !linuxRoot }, async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "lightmoni-executor-negative-")), release = join(root, "service");
  makeReleaseRoot(release);
  const bytes = releaseBundle({ service_id: "a".repeat(32), version: "v1", architecture: process.arch === "arm64" ? "linux-arm64" : "linux-amd64" });
  const base = { kind: "stage_artifact" as const, release_id: "release_1", service_id: "a".repeat(32), version: "v1", architecture: process.arch === "arm64" ? "linux-arm64" as const : "linux-amd64" as const, destination: "releases/v1", sha256: "0".repeat(64), size: bytes.length };
  const executor = new CapabilityExecutor({ now: () => new Date("2026-10-22T00:00:00Z"), command: async () => ({ stdout: "", stderr: "" }), downloadArtifact: async () => bytes });
  const digestFailure = await executor.execute({ id: "bad", expires_at: "2026-10-22T00:10:00Z", capabilities: ["artifact.stage"], target: { releaseDirectory: release, unit: "checkout.service" }, actions: [base] });
  assert.equal(digestFailure.code, "digest_mismatch");
  const pathFailure = await executor.execute({ id: "bad", expires_at: "2026-10-22T00:10:00Z", capabilities: ["artifact.stage"], target: { releaseDirectory: release, unit: "checkout.service" }, actions: [{ ...base, destination: "../../outside" }] });
  assert.equal(pathFailure.code, "invalid_artifact");
  const arbitrarySource = await executor.execute({ id: "bad", expires_at: "2026-10-22T00:10:00Z", capabilities: ["artifact.stage"], target: { releaseDirectory: release, unit: "checkout.service" }, actions: [{ ...base, source: "https://example.invalid/artifact" } as any] });
  assert.equal(arbitrarySource.code, "invalid_artifact");
  const unitFailure = await executor.execute({ id: "bad", expires_at: "2026-10-22T00:10:00Z", capabilities: ["systemd.restart"], target: { releaseDirectory: release, unit: "checkout.service" }, actions: [{ kind: "systemd", operation: "restart", unit: "other.service" }] });
  assert.equal(unitFailure.code, "capability_denied");
  const unknown = await executor.execute({ id: "bad", expires_at: "2026-10-22T00:10:00Z", capabilities: ["shell.exec"], target: { releaseDirectory: release, unit: "checkout.service" }, actions: [{ kind: "shell.exec" } as any] });
  assert.equal(unknown.code, "capability_denied");
});

test("release staging checks size, manifest binding and immutability before publishing", { skip: !linuxRoot }, async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "lightmoni-stage-bundle-")), release = join(root, "service");
  makeReleaseRoot(release);
  const bytes = releaseBundle({ service_id: "a".repeat(32), version: "v1", architecture: process.arch === "arm64" ? "linux-arm64" : "linux-amd64" });
  const base = { kind: "stage_artifact" as const, release_id: "release_1", service_id: "a".repeat(32), version: "v1", architecture: process.arch === "arm64" ? "linux-arm64" as const : "linux-amd64" as const, destination: "releases/v1", sha256: digest(bytes), size: bytes.length };
  const run = async (action: typeof base, downloaded: Buffer) => new CapabilityExecutor({
    now: () => new Date("2026-10-22T00:00:00Z"), downloadArtifact: async () => downloaded,
  }).execute({ id: "job", expires_at: "2026-10-22T00:10:00Z", capabilities: ["artifact.stage"], target: { releaseDirectory: release, unit: "checkout.service" }, actions: [action] });

  const badSize = await run({ ...base, size: bytes.length + 1 }, bytes);
  assert.equal(badSize.code, "size_mismatch");
  const wrongManifest = releaseBundle({ service_id: "b".repeat(32), version: "v1", architecture: base.architecture });
  const wrongService = await run({ ...base, sha256: digest(wrongManifest), size: wrongManifest.length }, wrongManifest);
  assert.equal(wrongService.code, "invalid_artifact");
  assert.equal(existsSync(join(release, "releases", "v1")), false);

  const staged = await run(base, bytes);
  assert.equal(staged.state, "succeeded");
  const duplicate = await run(base, bytes);
  assert.equal(duplicate.code, "artifact_conflict");
  assert.equal(readFileSync(join(release, "releases", "v1", "run"), "utf8"), "#!/bin/sh\necho hello\n");
});

test("release staging rejects path ancestors and roots with unsafe ownership permissions", { skip: process.platform !== "linux" }, async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "lightmoni-protected-release-"));
  const unsafeParent = join(root, "writable-parent"), unsafeRelease = join(unsafeParent, "service");
  mkdirSync(unsafeRelease, { recursive: true });
  chmodSync(unsafeParent, 0o777);
  const safeParent = join(root, "safe-parent"), writableRelease = join(safeParent, "service");
  mkdirSync(writableRelease, { recursive: true });
  chmodSync(safeParent, 0o750);
  chmodSync(writableRelease, 0o770);
  const probe = async (releaseDirectory: string) => new CapabilityExecutor({
    now: () => new Date("2026-10-22T00:00:00Z"),
    command: async () => ({ stdout: systemdOutput(releaseDirectory), stderr: "" }),
  }).execute({
    id: "probe", expires_at: "2026-10-22T00:10:00Z", capabilities: ["systemd.probe"],
    target: { releaseDirectory, unit: "checkout.service" },
    actions: [{ kind: "systemd_probe", unit: "checkout.service", releaseDirectory, preflightID: "b".repeat(32), targetRevision: "a".repeat(64) }],
  });
  const ancestorResult = await probe(unsafeRelease);
  assert.equal(ancestorResult.snapshot.preflight.ready, false);
  assert.equal(ancestorResult.snapshot.preflight.release_directory_writable, false);
  const rootResult = await probe(writableRelease);
  assert.equal(rootResult.snapshot.preflight.ready, false);
  assert.equal(rootResult.snapshot.preflight.release_directory_writable, false);

  const wrongOwnerRelease = join(safeParent, "wrong-owner");
  makeReleaseRoot(wrongOwnerRelease);
  if (process.geteuid?.() === 0) chownSync(wrongOwnerRelease, 65534, process.getgid?.() ?? 0);
  const wrongOwnerResult = await probe(wrongOwnerRelease);
  assert.equal(wrongOwnerResult.snapshot.preflight.ready, false, "the registered release root must be owned by root");
});


test("protected release path permits a root-owned sticky shared ancestor such as /tmp", { skip: !linuxRoot }, async () => {
  const shared = realpathSync(tmpdir());
  const base = mkdtempSync(join(shared, "lightmoni-sticky-release-"));
  const release = join(base, "service");
  mkdirSync(join(release, "releases", "v1"), { recursive: true });
  chmodSync(release, 0o755);
  writeFileSync(join(release, "releases", "v1", "run"), "#!/bin/sh\n", { mode: 0o555 });
  symlinkSync("releases/v1", join(release, "current"));
  const result = await new CapabilityExecutor({
    now: () => new Date("2026-10-22T00:00:00Z"),
    command: async () => ({ stdout: systemdOutput(release), stderr: "" }),
  }).execute({
    id: "probe", expires_at: "2026-10-22T00:10:00Z", capabilities: ["systemd.probe"],
    target: { releaseDirectory: release, unit: "checkout.service" },
    actions: [{ kind: "systemd_probe", unit: "checkout.service", releaseDirectory: release, preflightID: "b".repeat(32), targetRevision: "a".repeat(64) }],
  });
  assert.equal(result.snapshot.preflight.release_directory_writable, true);
  assert.equal(result.snapshot.preflight.ready, true);
});

test("bundle paths reserved for credentials are rejected while runtime payloads stay read-only to host users", { skip: !linuxRoot }, async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "lightmoni-private-release-files-")), release = join(root, "service");
  makeReleaseRoot(release);
  const privateBundle = releaseBundle(
    { service_id: "a".repeat(32), version: "v1", architecture: process.arch === "arm64" ? "linux-arm64" : "linux-amd64" },
    [{ name: ".env.production", content: Buffer.from("TOKEN=private\n"), mode: 0o600 }],
  );
  const action = {
    kind: "stage_artifact" as const, release_id: "release_1", service_id: "a".repeat(32), version: "v1",
    architecture: process.arch === "arm64" ? "linux-arm64" as const : "linux-amd64" as const,
    destination: "releases/v1", sha256: digest(privateBundle), size: privateBundle.length,
  };
  const result = await new CapabilityExecutor({ now: () => new Date("2026-10-22T00:00:00Z"), downloadArtifact: async () => privateBundle }).execute({
    id: "job", expires_at: "2026-10-22T00:10:00Z", capabilities: ["artifact.stage"],
    target: { releaseDirectory: release, unit: "checkout.service" }, actions: [action],
  });
  assert.equal(result.code, "invalid_artifact");
  assert.equal(existsSync(join(release, "releases", "v1")), false);
});

test("release activation compares the prior symlink and leaves a changed current untouched", { skip: !linuxRoot }, async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "lightmoni-activate-cas-")), release = join(root, "service");
  mkdirSync(join(release, "releases", "v0"), { recursive: true });
  chmodSync(release, 0o755);
  writeFileSync(join(release, "releases", "v0", "run"), "#!/bin/sh\n", { mode: 0o550 });
  symlinkSync("releases/v0", join(release, "current"));
  const bytes = releaseBundle({ service_id: "a".repeat(32), version: "v1", architecture: process.arch === "arm64" ? "linux-arm64" : "linux-amd64" });
  const result = await new CapabilityExecutor({
    now: () => new Date("2026-10-22T00:00:00Z"), downloadArtifact: async () => bytes,
  }).execute({
    id: "job", expires_at: "2026-10-22T00:10:00Z", capabilities: ["artifact.stage", "artifact.activate_release"],
    target: { releaseDirectory: release, unit: "checkout.service" },
    actions: [
      { kind: "stage_artifact", release_id: "release_1", service_id: "a".repeat(32), version: "v1", architecture: process.arch === "arm64" ? "linux-arm64" : "linux-amd64", destination: "releases/v1", sha256: digest(bytes), size: bytes.length },
      { kind: "activate_release", releaseDirectory: release, version: "v1", expectedCurrentVersion: "" },
    ],
  });
  assert.equal(result.code, "artifact_conflict");
  assert.equal(readlinkSync(join(release, "current")), "releases/v0");
  const activated = await new CapabilityExecutor({ now: () => new Date("2026-10-22T00:00:00Z") }).execute({
    id: "activate", expires_at: "2026-10-22T00:10:00Z", capabilities: ["artifact.activate_release"],
    target: { releaseDirectory: release, unit: "checkout.service" },
    actions: [{ kind: "activate_release", releaseDirectory: release, version: "v1", expectedCurrentVersion: "v0" }],
  });
  assert.equal(activated.state, "succeeded");
  assert.equal(activated.snapshot.previous_version, "v0");
  assert.equal(readlinkSync(join(release, "current")), "releases/v1");
});

test("systemd preflight is read-only, target-bound, structured, and redacts command output", { skip: !linuxRoot }, async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "lightmoni-preflight-")), release = join(root, "service");
  mkdirSync(join(release, "releases", "v1"), { recursive: true });
  chmodSync(release, 0o755);
  symlinkSync("releases/v1", join(release, "current"));
  const calls: string[][] = [];
  const executor = new CapabilityExecutor({
    now: () => new Date("2026-10-22T00:00:00Z"),
    command: async (file, args) => { assert.equal(file, "systemctl"); calls.push(args); return { stdout: systemdOutput(release), stderr: "sensitive host detail" }; },
  });
  const result = await executor.execute({
    id: "probe", expires_at: "2026-10-22T00:10:00Z", capabilities: ["systemd.probe"],
    target: { releaseDirectory: release, unit: "checkout.service" },
    actions: [{ kind: "systemd_probe", unit: "checkout.service", releaseDirectory: release, preflightID: "b".repeat(32), targetRevision: "a".repeat(64) }],
  });
  assert.equal(result.state, "succeeded");
  assert.deepEqual(calls, [["show", "--no-pager", "--property=LoadState", "--property=ActiveState", "--property=UnitFileState", "--property=ExecStart", "checkout.service"]]);
  assert.equal(result.snapshot.preflight.filesystem_check_supported, process.platform === "linux");
  assert.equal(result.snapshot.preflight.ready, process.platform === "linux");
  assert.equal(result.snapshot.preflight.current_version, process.platform === "linux" ? "v1" : "");
  assert.equal(result.snapshot.preflight.entrypoint_matches, true);
  assert.equal(result.snapshot.preflight.current_pointer_valid, process.platform === "linux");
  assert.equal(result.snapshot.preflight.unit_file_state, "enabled");
  assert.equal(result.snapshot.preflight.preflight_id, "b".repeat(32));
  assert.equal(result.snapshot.preflight.target_revision, "a".repeat(64));
  assert.equal(JSON.stringify(result).includes("sensitive host detail"), false);
  assert.equal(JSON.stringify(result).includes("daemon-reload"), false);
});

test("systemd preflight accepts a missing current symlink for first deployment", { skip: !linuxRoot }, async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "lightmoni-preflight-first-deploy-")), release = join(root, "service");
  makeReleaseRoot(release);
  const result = await new CapabilityExecutor({
    now: () => new Date("2026-10-22T00:00:00Z"), command: async () => ({ stdout: systemdOutput(release), stderr: "" }),
  }).execute({
    id: "probe", expires_at: "2026-10-22T00:10:00Z", capabilities: ["systemd.probe"],
    target: { releaseDirectory: release, unit: "checkout.service" },
    actions: [{ kind: "systemd_probe", unit: "checkout.service", releaseDirectory: release, preflightID: "b".repeat(32), targetRevision: "a".repeat(64) }],
  });
  assert.equal(result.state, "succeeded");
  assert.equal(result.snapshot.preflight.current_version, "");
  assert.equal(result.snapshot.preflight.current_pointer_valid, process.platform === "linux");
  assert.equal(result.snapshot.preflight.ready, process.platform === "linux");
});

test("systemd preflight rejects mixed write capabilities, mismatched targets, and malformed systemctl output", async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "lightmoni-preflight-negative-")), release = join(root, "service");
  mkdirSync(release);
  let calls = 0;
  const executor = new CapabilityExecutor({
    now: () => new Date("2026-10-22T00:00:00Z"),
    command: async () => { calls++; return { stdout: "LoadState=loaded\nActiveState=active\nUnitFileState=enabled\nSECRET=bad\n", stderr: "secret" }; },
  });
  const base = { id: "probe", expires_at: "2026-10-22T00:10:00Z", target: { releaseDirectory: release, unit: "checkout.service" }, actions: [{ kind: "systemd_probe" as const, unit: "checkout.service", releaseDirectory: release, preflightID: "b".repeat(32), targetRevision: "a".repeat(64) }] };
  const mixed = await executor.execute({ ...base, capabilities: ["systemd.probe", "systemd.restart"] });
  assert.equal(mixed.code, "capability_denied");
  assert.equal(calls, 0);
  const mismatch = await executor.execute({ ...base, capabilities: ["systemd.probe"], actions: [{ kind: "systemd_probe", unit: "other.service", releaseDirectory: release }] });
  assert.equal(mismatch.code, "capability_denied");
  assert.equal(calls, 0);
  const malformed = await executor.execute({ ...base, capabilities: ["systemd.probe"] });
  assert.equal(malformed.code, "invalid_preflight_result");
  assert.equal(JSON.stringify(malformed).includes("SECRET=bad"), false);
  assert.equal(calls, 1);
});

test("systemd preflight requires one exact registered current/run entrypoint", async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "lightmoni-preflight-entrypoint-")), release = join(root, "service");
  mkdirSync(release);
  const expected = join(release, "current", "run");
  const wrongCommands = [
    `{ path=/usr/bin/other ; argv[]=${expected} ; ignore_errors=no }`,
    `{ path=${expected} ; argv[]=/usr/bin/other ; ignore_errors=no }`,
    `{ path=${expected} ; argv[]=${expected} ; ignore_errors=no } { path=${expected} ; argv[]=${expected} ; ignore_errors=no }`,
  ];
  for (const execStart of wrongCommands) {
    const result = await new CapabilityExecutor({
      now: () => new Date("2026-10-22T00:00:00Z"),
      command: async () => ({ stdout: systemdOutput(release, { execStart }), stderr: "" }),
    }).execute({
      id: "probe", expires_at: "2026-10-22T00:10:00Z", capabilities: ["systemd.probe"],
      target: { releaseDirectory: release, unit: "checkout.service" },
      actions: [{ kind: "systemd_probe", unit: "checkout.service", releaseDirectory: release, preflightID: "b".repeat(32), targetRevision: "a".repeat(64) }],
    });
    assert.equal(result.state, "succeeded");
    assert.equal(result.snapshot.preflight.entrypoint_matches, false);
    assert.equal(result.snapshot.preflight.ready, false);
  }

  // A legacy regular-file pointer and an unrelated symlink are not treated as
  // a deployed version, even when the systemd command itself is correct.
  for (const makeCurrent of [
    (path: string) => writeFileSync(path, "v1\n"),
    (path: string) => symlinkSync("../elsewhere", path),
  ]) {
    const pointerRoot = mkdtempSync(join(realpathSync(tmpdir()), "lightmoni-preflight-pointer-")), pointerRelease = join(pointerRoot, "service");
    mkdirSync(pointerRelease);
    makeCurrent(join(pointerRelease, "current"));
    const result = await new CapabilityExecutor({
      now: () => new Date("2026-10-22T00:00:00Z"), command: async () => ({ stdout: systemdOutput(pointerRelease), stderr: "" }),
    }).execute({
      id: "probe", expires_at: "2026-10-22T00:10:00Z", capabilities: ["systemd.probe"],
      target: { releaseDirectory: pointerRelease, unit: "checkout.service" },
      actions: [{ kind: "systemd_probe", unit: "checkout.service", releaseDirectory: pointerRelease, preflightID: "b".repeat(32), targetRevision: "a".repeat(64) }],
    });
    assert.equal(result.snapshot.preflight.current_version, "");
    assert.equal(result.snapshot.preflight.current_pointer_valid, false);
    assert.equal(result.snapshot.preflight.ready, false);
  }
});

test("systemd preflight rejects symlinked release paths, masked units, transitional states, timeout and cancellation", async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "lightmoni-preflight-boundary-"));
  const outside = join(root, "outside"), linked = join(root, "linked");
  mkdirSync(outside);
  mkdirSync(join(outside, "service"));
  symlinkSync(outside, linked);
  const standard = { id: "probe", expires_at: "2026-10-22T00:10:00Z", capabilities: ["systemd.probe"], target: { releaseDirectory: join(linked, "service"), unit: "checkout.service" } };
  const symlinked = await new CapabilityExecutor({ now: () => new Date("2026-10-22T00:00:00Z"), command: async () => ({ stdout: systemdOutput(join(linked, "service")), stderr: "" }) }).execute({
    ...standard, actions: [{ kind: "systemd_probe", unit: "checkout.service", releaseDirectory: standard.target.releaseDirectory, preflightID: "b".repeat(32), targetRevision: "a".repeat(64) }],
  });
  assert.equal(symlinked.state, "succeeded");
  assert.equal(symlinked.snapshot.preflight.ready, false);

  const safeRelease = join(root, "safe-service");
  mkdirSync(safeRelease);
  for (const output of [
    systemdOutput(safeRelease, { activeState: "inactive", unitFileState: "masked" }),
    systemdOutput(safeRelease, { activeState: "activating", unitFileState: "enabled" }),
  ]) {
    const result = await new CapabilityExecutor({
      now: () => new Date("2026-10-22T00:00:00Z"),
      command: async () => ({ stdout: output, stderr: "" }),
    }).execute({ ...standard, target: { releaseDirectory: safeRelease, unit: "checkout.service" }, actions: [{ kind: "systemd_probe", unit: "checkout.service", releaseDirectory: safeRelease, preflightID: "b".repeat(32), targetRevision: "a".repeat(64) }] });
    assert.equal(result.snapshot.preflight.ready, false);
  }

  const timedOut = await new CapabilityExecutor({
    now: () => new Date("2026-10-22T00:00:00Z"),
    command: async () => { throw Object.assign(Error("timeout details"), { code: "ETIMEDOUT" }); },
  }).execute({ ...standard, target: { releaseDirectory: safeRelease, unit: "checkout.service" }, actions: [{ kind: "systemd_probe", unit: "checkout.service", releaseDirectory: safeRelease, preflightID: "b".repeat(32), targetRevision: "a".repeat(64) }] });
  assert.equal(timedOut.state, "failed");
  assert.equal(timedOut.code, "systemd_failed");
  assert.equal(timedOut.summary.includes("timeout details"), false);

  const controller = new AbortController();
  const cancelled = await new CapabilityExecutor({
    now: () => new Date("2026-10-22T00:00:00Z"),
    command: async () => { controller.abort(); throw Error("cancelled command"); },
  }).execute({ ...standard, target: { releaseDirectory: safeRelease, unit: "checkout.service" }, actions: [{ kind: "systemd_probe", unit: "checkout.service", releaseDirectory: safeRelease, preflightID: "b".repeat(32), targetRevision: "a".repeat(64) }] }, controller.signal);
  assert.equal(cancelled.state, "unknown");
  assert.equal(cancelled.code, "execution_cancelled");
});

test("systemd preflight does not block when current is a FIFO", { skip: process.platform !== "linux" }, async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "lightmoni-preflight-fifo-")), release = join(root, "service");
  mkdirSync(release);
  execFileSync("mkfifo", [join(release, "current")]);
  const executor = new CapabilityExecutor({
    now: () => new Date("2026-10-22T00:00:00Z"),
    command: async () => ({ stdout: systemdOutput(release), stderr: "" }),
  });
  const result = await Promise.race([
    executor.execute({
      id: "probe", expires_at: "2026-10-22T00:10:00Z", capabilities: ["systemd.probe"],
      target: { releaseDirectory: release, unit: "checkout.service" },
      actions: [{ kind: "systemd_probe", unit: "checkout.service", releaseDirectory: release, preflightID: "b".repeat(32), targetRevision: "a".repeat(64) }],
    }),
    new Promise<never>((_, reject) => setTimeout(() => reject(Error("FIFO preflight blocked")), 1000)),
  ]);
  assert.equal(result.snapshot.preflight.ready, false);
  assert.equal(result.snapshot.preflight.current_version, "");
});

test("artifact staging refuses symlinked target ancestors", { skip: process.platform !== "linux" }, async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "lightmoni-stage-symlink-"));
  const outside = join(root, "outside"), linked = join(root, "linked");
  mkdirSync(outside);
  symlinkSync(outside, linked);
  const release = join(linked, "service");
  const bytes = releaseBundle({ service_id: "a".repeat(32), version: "v1", architecture: process.arch === "arm64" ? "linux-arm64" : "linux-amd64" });
  const result = await new CapabilityExecutor({ now: () => new Date("2026-10-22T00:00:00Z"), downloadArtifact: async () => bytes }).execute({
    id: "stage", expires_at: "2026-10-22T00:10:00Z", capabilities: ["artifact.stage"],
    target: { releaseDirectory: release, unit: "checkout.service" },
    actions: [{ kind: "stage_artifact", release_id: "release_1", service_id: "a".repeat(32), version: "v1", architecture: process.arch === "arm64" ? "linux-arm64" : "linux-amd64", destination: "releases/v1", sha256: digest(bytes), size: bytes.length }],
  });
  assert.equal(result.state, "failed");
  assert.equal(result.code, "invalid_target");
  assert.equal(existsSync(join(outside, "service")), false);
});
