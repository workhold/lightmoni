import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeDeploymentVerification, verifyTelemetry } from "../src/deployment/verification.js";

const request = {
  serviceId: "service-1",
  deploymentId: "deployment-1",
  instanceId: "instance-1",
  from: "2026-10-22T00:00:00.000Z",
  to: "2026-10-22T00:01:00.000Z",
  deadline: "2026-10-22T00:05:00.000Z",
};

test("telemetry verification counts only exact service, instance and window matches", () => {
  const result = verifyTelemetry(request, [
    { service: "service-1", instanceId: "instance-1", eventTime: "2026-10-22T00:00:30.000Z" },
    { service: "other", instanceId: "instance-1", eventTime: "2026-10-22T00:00:31.000Z" },
    { service: "service-1", instanceId: "other", eventTime: "2026-10-22T00:00:32.000Z" },
    { service: "service-1", instanceId: "instance-1", eventTime: "2026-10-22T00:01:00.000Z" },
    { service: "service-1", instanceId: "instance-1" },
  ], new Date("2026-10-22T00:02:00.000Z"));
  assert.equal(result.state, "verified");
  assert.equal(result.observedSamples, 1);
  assert.equal(result.code, "verified");
});

test("telemetry verification distinguishes delayed data, timeout and unavailable query", () => {
  const waiting = verifyTelemetry(request, [], new Date("2026-10-22T00:02:00.000Z"));
  assert.equal(waiting.state, "waiting");
  assert.equal(waiting.code, "no_matching_data");
  const timedOut = verifyTelemetry(request, [], new Date("2026-10-22T00:06:00.000Z"));
  assert.equal(timedOut.state, "timed_out");
  assert.equal(timedOut.code, "deadline_exceeded");
  const unavailable = verifyTelemetry(request, undefined, new Date("2026-10-22T00:02:00.000Z"));
  assert.equal(unavailable.state, "unavailable");
  assert.equal(unavailable.code, "query_unavailable");
});

test("telemetry verification rejects unsafe windows and unbounded result sets", () => {
  const invalid = verifyTelemetry({ ...request, from: "2026-10-22T00:00:00.000Z", to: "2026-10-22T01:00:00.000Z" }, [], new Date("2026-10-22T00:02:00.000Z"));
  assert.equal(invalid.state, "invalid");
  assert.equal(invalid.code, "invalid_request");
  const tooMany = verifyTelemetry(request, Array.from({ length: 1001 }, () => ({ service: request.serviceId, instanceId: request.instanceId, eventTime: "2026-10-22T00:00:30.000Z" })));
  assert.equal(tooMany.state, "invalid");
  assert.equal(tooMany.code, "too_many_rows");
});

test("healthy service is explicitly successful but telemetry-unverified", () => {
  const telemetry = verifyTelemetry(request, [], new Date("2026-10-22T00:06:00.000Z"));
  const health = [{ check: { kind: "systemd-active", unit: "checkout.service" } as const, healthy: true }];
  const unverified = summarizeDeploymentVerification(health, telemetry);
  assert.equal(unverified.state, "succeeded_telemetry_unverified");
  assert.equal(unverified.healthy, true);
  const failed = summarizeDeploymentVerification([{ ...health[0], healthy: false }], telemetry);
  assert.equal(failed.state, "failed");
  const verified = summarizeDeploymentVerification(health, { ...telemetry, state: "verified", code: "verified", observedSamples: 1 });
  assert.equal(verified.state, "succeeded");
});

