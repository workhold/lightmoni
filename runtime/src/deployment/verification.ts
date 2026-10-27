import type { HealthCheckResult } from "./types.js";
import { parseNanoTime } from "../shared/otlp.js";

/**
 * Centre-side verification primitives.
 *
 * This module deliberately does not perform HTTP, ClickHouse or systemd I/O.
 * An Agent/executor supplies bounded observations and the centre decides how
 * to interpret them. That keeps credentials and untrusted host output out of
 * the state machine while making the “healthy but telemetry not verified”
 * result explicit.
 */

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_ROWS = 1000;
const MAX_WINDOW_MS = 15 * 60 * 1000;

export type TelemetryVerificationState =
  | "verified"
  | "waiting"
  | "timed_out"
  | "unavailable"
  | "invalid";

export interface TelemetryVerificationRequest {
  serviceId: string;
  deploymentId: string;
  instanceId?: string;
  /** Explicit SDK identity; platform service IDs are not SDK service.name. */
  selector?: { service: string; instance_id: string };
  serviceVersion?: string;
  from: string;
  to: string;
  deadline: string;
  minSamples?: number;
}

export interface TelemetryObservation {
  service: string;
  instanceId?: string;
  eventTime?: string;
  serviceVersion?: string;
  ingestedAt?: string;
}

export interface TelemetryVerificationResult {
  state: TelemetryVerificationState;
  serviceId: string;
  deploymentId: string;
  observedSamples: number;
  minSamples: number;
  from: string;
  to: string;
  checkedAt: string;
  code: "verified" | "no_matching_data" | "deadline_exceeded" | "query_unavailable" | "invalid_request" | "too_many_rows";
}

export type DeploymentVerificationState =
  | "succeeded"
  | "succeeded_telemetry_unverified"
  | "failed"
  | "waiting";

export interface DeploymentVerificationSummary {
  state: DeploymentVerificationState;
  healthy: boolean;
  telemetry: TelemetryVerificationResult;
  healthChecks: HealthCheckResult[];
}

function validID(value: unknown): value is string {
  return typeof value === "string" && ID.test(value);
}

function parseTime(value: unknown): bigint | undefined {
  if (typeof value !== "string") return undefined;
  try {
    return parseNanoTime(value);
  } catch {
    return undefined;
  }
}

function identity(value: unknown, maxBytes: number): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value &&
    !/[\p{Cc}\p{Cs}]/u.test(value) && Buffer.byteLength(value, "utf8") <= maxBytes;
}

function invalidResult(input: TelemetryVerificationRequest, checkedAt: string, code: TelemetryVerificationResult["code"]): TelemetryVerificationResult {
  return {
    state: "invalid",
    serviceId: typeof input.serviceId === "string" ? input.serviceId.slice(0, 128) : "",
    deploymentId: typeof input.deploymentId === "string" ? input.deploymentId.slice(0, 128) : "",
    observedSamples: 0,
    minSamples: 1,
    from: typeof input.from === "string" ? input.from : "",
    to: typeof input.to === "string" ? input.to : "",
    checkedAt,
    code,
  };
}

/**
 * Verify a bounded set of already-fetched telemetry rows.
 *
 * Rows are treated as evidence, never as instructions. Only exact service and
 * optional instance matches inside the requested UTC window count. The
 * caller must fetch at most MAX_ROWS rows and must pass a fixed deadline.
 */
export function verifyTelemetry(
  input: TelemetryVerificationRequest,
  rows: readonly TelemetryObservation[] | undefined,
  now = new Date(),
): TelemetryVerificationResult {
  const validNow = Number.isFinite(now.getTime());
  const checkedAt = validNow ? now.toISOString() : "1970-01-01T00:00:00.000Z";
  const from = parseTime(input.from), to = parseTime(input.to), deadline = parseTime(input.deadline);
  const minSamples = input.minSamples ?? 1;
  if (
    !validID(input.serviceId) ||
    !validID(input.deploymentId) ||
    (input.instanceId != null && !validID(input.instanceId)) ||
    (input.selector != null && (!identity(input.selector.service, 256) || !identity(input.selector.instance_id, 128))) ||
    (input.serviceVersion != null && !identity(input.serviceVersion, 128)) ||
    !validNow ||
    from == null ||
    to == null ||
    deadline == null ||
    to <= from ||
    to - from > BigInt(MAX_WINDOW_MS) * 1_000_000n ||
    deadline < to ||
    !Number.isInteger(minSamples) ||
    minSamples < 1 ||
    minSamples > MAX_ROWS
  ) {
    return invalidResult(input, checkedAt, "invalid_request");
  }
  const currentTime = BigInt(now.getTime()) * 1_000_000n;
  if (currentTime <= from) {
    return { state: "waiting", serviceId: input.serviceId, deploymentId: input.deploymentId, observedSamples: 0, minSamples, from: input.from, to: input.to, checkedAt, code: "no_matching_data" };
  }
  if (!rows) {
    return {
      ...invalidResult(input, checkedAt, "query_unavailable"),
      state: "unavailable",
      minSamples,
    };
  }
  if (rows.length > MAX_ROWS) {
    return {
      ...invalidResult(input, checkedAt, "too_many_rows"),
      minSamples,
    };
  }
  const observedSamples = rows.reduce((count, row) => {
    if (!row || typeof row !== "object") return count;
    if (row.service !== (input.selector?.service ?? input.serviceId)) return count;
    const instance = input.selector?.instance_id ?? input.instanceId;
    if (instance != null && row.instanceId !== instance) return count;
    if (input.serviceVersion != null && row.serviceVersion !== input.serviceVersion) return count;
    // An observation without a timestamp cannot prove it belongs to this
    // deployment's window, so it is deliberately ignored.
    const eventTime = parseTime(row.eventTime);
    if (eventTime == null || eventTime < from || eventTime >= to || eventTime >= currentTime) return count;
    if (input.serviceVersion != null) {
      const ingestedAt = parseTime(row.ingestedAt);
      if (ingestedAt == null || ingestedAt < from || ingestedAt > currentTime) return count;
    }
    return count + 1;
  }, 0);
  if (observedSamples >= minSamples) {
    return { state: "verified", serviceId: input.serviceId, deploymentId: input.deploymentId, observedSamples, minSamples, from: input.from, to: input.to, checkedAt, code: "verified" };
  }
  if (currentTime >= deadline) {
    return { state: "timed_out", serviceId: input.serviceId, deploymentId: input.deploymentId, observedSamples, minSamples, from: input.from, to: input.to, checkedAt, code: "deadline_exceeded" };
  }
  return { state: "waiting", serviceId: input.serviceId, deploymentId: input.deploymentId, observedSamples, minSamples, from: input.from, to: input.to, checkedAt, code: "no_matching_data" };
}

/**
 * Combine typed health observations with telemetry evidence. A healthy
 * process with delayed/missing telemetry is still a successful deployment,
 * but is explicitly marked as unverified so callers can schedule a retry.
 */
export function summarizeDeploymentVerification(
  healthChecks: readonly HealthCheckResult[],
  telemetry: TelemetryVerificationResult,
): DeploymentVerificationSummary {
  const checks = healthChecks.map((check) => ({ ...check }));
  const healthy = checks.length > 0 && checks.every((check) => check.healthy === true);
  let state: DeploymentVerificationState;
  if (!healthy) state = checks.length ? "failed" : "waiting";
  else if (telemetry.state === "verified") state = "succeeded";
  else if (["waiting", "timed_out", "unavailable"].includes(telemetry.state)) state = "succeeded_telemetry_unverified";
  else state = "waiting";
  return { state, healthy, telemetry, healthChecks: checks };
}

