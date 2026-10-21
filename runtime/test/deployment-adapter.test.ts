import test from "node:test";
import assert from "node:assert/strict";
import { SystemdDeploymentAdapter, type ServiceSpec, type SystemdSnapshot } from "../src/deployment/index.js";

const target = {
  id: "payments-prod",
  provider: "systemd" as const,
  unit: "payments.service",
  releaseDirectory: "/opt/lightmoni/services/payments",
};

const snapshot = (overrides: Partial<SystemdSnapshot> = {}): SystemdSnapshot => ({
  available: true,
  unitExists: true,
  activeState: "active",
  enabled: true,
  currentVersion: "2026.10.20",
  currentArtifact: "/opt/releases/payments-2026.10.20.tar.zst",
  ...overrides,
});

const spec: ServiceSpec = {
  serviceId: "payments",
  target,
  artifact: {
    source: "/var/lib/lightmoni/artifacts/payments-2026.10.21.tar.zst",
    version: "2026.10.21",
    sha256: "a".repeat(64),
  },
  enableOnBoot: true,
  healthChecks: [{ kind: "systemd-active", unit: target.unit }],
};

test("systemd adapter reports preflight issues without executing remote commands", () => {
  const adapter = new SystemdDeploymentAdapter();
  const result = adapter.probe({ target, snapshot: snapshot({ available: false }) });
  assert.equal(result.supported, true);
  assert.equal(result.ready, false);
  assert.equal(result.issues[0]?.code, "systemd_unavailable");
  assert.throws(
    () => adapter.plan({ id: "deployment-unavailable", spec, probe: result }),
    /cannot create deployment plan/,
  );
});

test("systemd adapter creates a reviewable typed plan and requires approval", () => {
  const adapter = new SystemdDeploymentAdapter();
  const probe = adapter.probe({ target, snapshot: snapshot() });
  const plan = adapter.plan({ id: "deployment-1", spec, probe });
  assert.equal(plan.state, "awaiting_approval");
  assert.equal(plan.apply[0]?.kind, "stage_artifact");
  assert.equal(plan.apply[1]?.kind, "activate_release");
  assert.equal(plan.apply.some((action) => action.kind === "systemd" && action.operation === "restart"), true);
  assert.throws(() => adapter.apply(plan, false), /requires administrator approval/);
  const applied = adapter.apply(plan, true);
  assert.equal(applied.state, "activating");
  assert.equal(applied.planId, "deployment-1");
});

test("verification catches an activation/version mismatch and rollback is typed", () => {
  const adapter = new SystemdDeploymentAdapter();
  const plan = adapter.plan({ id: "deployment-2", spec, probe: adapter.probe({ target, snapshot: snapshot() }) });
  const failed = adapter.verify(plan, snapshot({ currentVersion: "old", activeState: "active" }), [
    { check: { kind: "systemd-active", unit: target.unit }, healthy: false, message: "unit is flapping" },
  ]);
  assert.equal(failed.state, "failed");
  assert.equal(failed.issues[0]?.code, "artifact_conflict");
  assert.equal(failed.issues.some((item) => item.code === "health_check_failed"), true);
  const rollback = adapter.rollback(plan);
  assert.equal(rollback.state, "rolling_back");
  assert.equal(rollback.actions.some((action) => action.kind === "activate_release"), true);
});

test("systemd adapter rejects paths and units that could escape its capability boundary", () => {
  const adapter = new SystemdDeploymentAdapter();
  const unsafe = { ...target, unit: "payments.service;id.service" };
  const probe = adapter.probe({ target: unsafe, snapshot: snapshot() });
  assert.equal(probe.ready, false);
  assert.equal(probe.issues.some((item) => item.code === "invalid_target"), true);
  assert.throws(
    () => adapter.plan({ id: "deployment-3", spec: { ...spec, target: unsafe }, probe }),
    /cannot create deployment plan/,
  );
});
