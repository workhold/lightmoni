import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, realpathSync, symlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digest } from "../src/agent/config.js";
import { CapabilityExecutor } from "../src/agent/executor.js";

test("capability executor stages matching digest and atomically activates release", { skip: process.platform !== "linux" }, async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "lightmoni-executor-"));
  const source = join(root, "artifact.tgz"), release = join(root, "service"), bytes = Buffer.from("release fixture\n");
  writeFileSync(source, bytes);
  const executor = new CapabilityExecutor({ now: () => new Date("2026-10-22T00:00:00Z"), command: async () => ({ stdout: "", stderr: "" }) });
  const result = await executor.execute({
    id: "job", expires_at: "2026-10-22T00:10:00Z", capabilities: ["artifact.stage", "artifact.activate_release"],
    target: { releaseDirectory: release, unit: "checkout.service" },
    actions: [
      { kind: "stage_artifact", source, destination: join(release, "releases", "v1"), sha256: digest(bytes) },
      { kind: "activate_release", releaseDirectory: release, version: "v1" },
    ],
  });
  assert.equal(result.state, "succeeded");
  assert.equal(existsSync(join(release, "current")), true);
});

test("capability executor rejects bad digest, path escape, unit mismatch and unknown capability", { skip: process.platform !== "linux" }, async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "lightmoni-executor-negative-")), source = join(root, "artifact"), release = join(root, "service");
  writeFileSync(source, "release");
  const executor = new CapabilityExecutor({ now: () => new Date("2026-10-22T00:00:00Z"), command: async () => ({ stdout: "", stderr: "" }) });
  const digestFailure = await executor.execute({ id: "bad", expires_at: "2026-10-22T00:10:00Z", capabilities: ["artifact.stage"], target: { releaseDirectory: release, unit: "checkout.service" }, actions: [{ kind: "stage_artifact", source, destination: join(release, "releases", "v1"), sha256: "0".repeat(64) }] });
  assert.equal(digestFailure.code, "digest_mismatch");
  const pathFailure = await executor.execute({ id: "bad", expires_at: "2026-10-22T00:10:00Z", capabilities: ["artifact.stage"], target: { releaseDirectory: release, unit: "checkout.service" }, actions: [{ kind: "stage_artifact", source, destination: join(root, "outside", "v1"), sha256: digest("release") }] });
  assert.equal(pathFailure.code, "invalid_target");
  const unitFailure = await executor.execute({ id: "bad", expires_at: "2026-10-22T00:10:00Z", capabilities: ["systemd.restart"], target: { releaseDirectory: release, unit: "checkout.service" }, actions: [{ kind: "systemd", operation: "restart", unit: "other.service" }] });
  assert.equal(unitFailure.code, "capability_denied");
  const unknown = await executor.execute({ id: "bad", expires_at: "2026-10-22T00:10:00Z", capabilities: ["shell.exec"], target: { releaseDirectory: release, unit: "checkout.service" }, actions: [{ kind: "shell.exec" } as any] });
  assert.equal(unknown.code, "capability_denied");
});

test("systemd preflight is read-only, target-bound, structured, and redacts command output", async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "lightmoni-preflight-")), release = join(root, "service");
  mkdirSync(release);
  writeFileSync(join(release, "current"), "v1\n");
  const calls: string[][] = [];
  const executor = new CapabilityExecutor({
    now: () => new Date("2026-10-22T00:00:00Z"),
    command: async (file, args) => { assert.equal(file, "systemctl"); calls.push(args); return { stdout: "LoadState=loaded\nActiveState=active\nUnitFileState=enabled\n", stderr: "sensitive host detail" }; },
  });
  const result = await executor.execute({
    id: "probe", expires_at: "2026-10-22T00:10:00Z", capabilities: ["systemd.probe"],
    target: { releaseDirectory: release, unit: "checkout.service" },
    actions: [{ kind: "systemd_probe", unit: "checkout.service", releaseDirectory: release, preflightID: "b".repeat(32), targetRevision: "a".repeat(64) }],
  });
  assert.equal(result.state, "succeeded");
  assert.deepEqual(calls, [["show", "--no-pager", "--property=LoadState", "--property=ActiveState", "--property=UnitFileState", "checkout.service"]]);
  assert.equal(result.snapshot.preflight.filesystem_check_supported, process.platform === "linux");
  assert.equal(result.snapshot.preflight.ready, process.platform === "linux");
  assert.equal(result.snapshot.preflight.current_version, process.platform === "linux" ? "v1" : "");
  assert.equal(result.snapshot.preflight.unit_file_state, "enabled");
  assert.equal(result.snapshot.preflight.preflight_id, "b".repeat(32));
  assert.equal(result.snapshot.preflight.target_revision, "a".repeat(64));
  assert.equal(JSON.stringify(result).includes("sensitive host detail"), false);
  assert.equal(JSON.stringify(result).includes("daemon-reload"), false);
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

test("systemd preflight rejects symlinked release paths, masked units, transitional states, timeout and cancellation", async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "lightmoni-preflight-boundary-"));
  const outside = join(root, "outside"), linked = join(root, "linked");
  mkdirSync(outside);
  mkdirSync(join(outside, "service"));
  symlinkSync(outside, linked);
  const standard = { id: "probe", expires_at: "2026-10-22T00:10:00Z", capabilities: ["systemd.probe"], target: { releaseDirectory: join(linked, "service"), unit: "checkout.service" } };
  const symlinked = await new CapabilityExecutor({ now: () => new Date("2026-10-22T00:00:00Z"), command: async () => ({ stdout: "LoadState=loaded\nActiveState=active\nUnitFileState=enabled\n", stderr: "" }) }).execute({
    ...standard, actions: [{ kind: "systemd_probe", unit: "checkout.service", releaseDirectory: standard.target.releaseDirectory, preflightID: "b".repeat(32), targetRevision: "a".repeat(64) }],
  });
  assert.equal(symlinked.state, "succeeded");
  assert.equal(symlinked.snapshot.preflight.ready, false);

  const safeRelease = join(root, "safe-service");
  mkdirSync(safeRelease);
  for (const output of [
    "LoadState=loaded\nActiveState=inactive\nUnitFileState=masked\n",
    "LoadState=loaded\nActiveState=activating\nUnitFileState=enabled\n",
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
    command: async () => ({ stdout: "LoadState=loaded\nActiveState=active\nUnitFileState=enabled\n", stderr: "" }),
  });
  const result = await Promise.race([
    executor.execute({
      id: "probe", expires_at: "2026-10-22T00:10:00Z", capabilities: ["systemd.probe"],
      target: { releaseDirectory: release, unit: "checkout.service" },
      actions: [{ kind: "systemd_probe", unit: "checkout.service", releaseDirectory: release, preflightID: "b".repeat(32), targetRevision: "a".repeat(64) }],
    }),
    new Promise<never>((_, reject) => setTimeout(() => reject(Error("FIFO preflight blocked")), 1000)),
  ]);
  assert.equal(result.snapshot.preflight.ready, true);
  assert.equal(result.snapshot.preflight.current_version, "");
});

test("artifact staging refuses symlinked target ancestors", { skip: process.platform !== "linux" }, async () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "lightmoni-stage-symlink-"));
  const outside = join(root, "outside"), linked = join(root, "linked"), source = join(root, "artifact.tgz");
  mkdirSync(outside);
  symlinkSync(outside, linked);
  writeFileSync(source, "release fixture");
  const release = join(linked, "service");
  const result = await new CapabilityExecutor({ now: () => new Date("2026-10-22T00:00:00Z") }).execute({
    id: "stage", expires_at: "2026-10-22T00:10:00Z", capabilities: ["artifact.stage"],
    target: { releaseDirectory: release, unit: "checkout.service" },
    actions: [{ kind: "stage_artifact", source, destination: join(release, "releases", "v1"), sha256: digest("release fixture") }],
  });
  assert.equal(result.state, "failed");
  assert.equal(result.code, "invalid_target");
  assert.equal(existsSync(join(outside, "service")), false);
});
