import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digest } from "../src/agent/config.js";
import { CapabilityExecutor } from "../src/agent/executor.js";

test("capability executor stages matching digest and atomically activates release", async () => {
  const root = mkdtempSync(join(tmpdir(), "lightmoni-executor-"));
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

test("capability executor rejects bad digest, path escape, unit mismatch and unknown capability", async () => {
  const root = mkdtempSync(join(tmpdir(), "lightmoni-executor-negative-")), source = join(root, "artifact"), release = join(root, "service");
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
