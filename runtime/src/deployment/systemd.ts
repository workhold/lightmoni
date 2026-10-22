import {
  type ApplyResult,
  type DeploymentAction,
  type DeploymentAdapter,
  type DeploymentIssue,
  type DeploymentPlan,
  type HealthCheck,
  type HealthCheckResult,
  type ProbeResult,
  type RollbackResult,
  type ServiceSpec,
  type ServiceTarget,
  type SystemdSnapshot,
  type VerificationResult,
} from "./types.js";

const UNIT = /^[A-Za-z0-9][A-Za-z0-9_.@:-]{0,126}\.service$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256 = /^[a-fA-F0-9]{64}$/;
const ABSOLUTE = /^\/(?!\/)(?:[^\0\n\r]+)$/;
const HOST = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,252}$/;

function issue(code: DeploymentIssue["code"], message: string): DeploymentIssue {
  return { code, message };
}

function validPath(value: string): boolean {
  return ABSOLUTE.test(value) && !value.includes("\0") && !value.split("/").includes("..");
}

function validateTarget(target: ServiceTarget): DeploymentIssue[] {
  const issues: DeploymentIssue[] = [];
  if (!target.id || target.id.length > 128) issues.push(issue("invalid_target", "target id is required"));
  if (target.provider !== "systemd") issues.push(issue("invalid_target", "target provider is not systemd"));
  if (!UNIT.test(target.unit)) issues.push(issue("invalid_target", "systemd unit must end in .service"));
  if (!validPath(target.releaseDirectory)) issues.push(issue("invalid_target", "release directory must be an absolute controlled path"));
  return issues;
}

function validateSpec(spec: ServiceSpec): DeploymentIssue[] {
  const issues = validateTarget(spec.target);
  if (!spec.serviceId || spec.serviceId.length > 128) issues.push(issue("invalid_target", "service id is required"));
  if (!spec.artifact.release_id || spec.artifact.release_id.length > 128) issues.push(issue("invalid_artifact", "artifact release id is invalid"));
  if (spec.artifact.service_id !== spec.serviceId) issues.push(issue("invalid_artifact", "artifact service binding is invalid"));
  if (!VERSION.test(spec.artifact.version)) issues.push(issue("invalid_artifact", "artifact version is invalid"));
  if (!new Set(["any", "linux-amd64", "linux-arm64"]).has(spec.artifact.architecture)) issues.push(issue("invalid_artifact", "artifact architecture is invalid"));
  if (!SHA256.test(spec.artifact.sha256)) issues.push(issue("invalid_artifact", "artifact sha256 must be a hex digest"));
  if (!Number.isSafeInteger(spec.artifact.size) || spec.artifact.size < 1 || spec.artifact.size > 64 * 1024 * 1024) issues.push(issue("invalid_artifact", "artifact size is invalid"));
  for (const check of spec.healthChecks ?? []) {
    if (check.kind === "http") {
      try {
        const url = new URL(check.url);
        if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.hash)
          issues.push(issue("invalid_target", "HTTP health check must be an http(s) URL without credentials"));
      } catch {
        issues.push(issue("invalid_target", "HTTP health check URL is invalid"));
      }
    } else if (check.kind === "tcp" && (!HOST.test(check.host) || !Number.isInteger(check.port) || check.port < 1 || check.port > 65535)) {
      issues.push(issue("invalid_target", "TCP health check host or port is invalid"));
    } else if (check.kind === "systemd-active" && check.unit !== spec.target.unit) {
      issues.push(issue("invalid_target", "systemd health check must target the service unit"));
    }
  }
  return issues;
}

function releasePath(target: ServiceTarget, version: string): string {
  return `${target.releaseDirectory}/releases/${version}`;
}

function actionHealth(check: HealthCheck): DeploymentAction {
  return { kind: "health_check", check };
}

/**
 * A plan-only systemd adapter. It never spawns systemctl and never emits a
 * shell command. A trusted Agent executor is responsible for interpreting the
 * typed actions after administrator approval.
 */
export class SystemdDeploymentAdapter implements DeploymentAdapter {
  readonly provider = "systemd" as const;

  probe(input: { target: ServiceTarget; snapshot: SystemdSnapshot; now?: Date }): ProbeResult {
    const snapshot = input.snapshot;
    const issues = validateTarget(input.target);
    if (!snapshot || typeof snapshot !== "object") {
      issues.push(issue("snapshot_missing", "systemd preflight did not return a snapshot"));
    } else {
      if (!snapshot.available) issues.push(issue("systemd_unavailable", "systemd is not available on this host"));
      if (!snapshot.unitExists) issues.push(issue("unit_missing", `unit ${input.target.unit} does not exist`));
      if (snapshot.activeState === "failed") issues.push(issue("unit_inactive", `unit ${input.target.unit} is failed`));
    }
    const supported = issues.every((item) => item.code !== "invalid_target" && item.code !== "snapshot_missing");
    return {
      provider: this.provider,
      targetId: input.target.id,
      supported,
      ready: supported && issues.length === 0,
      snapshot,
      issues,
      observedAt: (input.now ?? new Date()).toISOString(),
    };
  }

  plan(input: { id: string; spec: ServiceSpec; probe: ProbeResult; now?: Date }): DeploymentPlan {
    const errors = validateSpec(input.spec);
    if (input.probe.provider !== this.provider || input.probe.targetId !== input.spec.target.id)
      errors.push(issue("invalid_target", "probe does not belong to this systemd target"));
    // A supported provider is not enough: the exact preflight snapshot must
    // be ready. This prevents planning against a missing unit or unavailable
    // systemd host when a caller only checks `supported`.
    if (!input.probe.supported || !input.probe.ready) errors.push(...input.probe.issues);
    if (errors.length) {
      const details = errors.map((item) => item.message).join("; ");
      throw new Error(`cannot create deployment plan: ${details}`);
    }
    const destination = releasePath(input.spec.target, input.spec.artifact.version);
    const apply: DeploymentAction[] = [
      {
        kind: "stage_artifact",
        release_id: input.spec.artifact.release_id,
        service_id: input.spec.serviceId,
        version: input.spec.artifact.version,
        architecture: input.spec.artifact.architecture,
        destination: `releases/${input.spec.artifact.version}`,
        sha256: input.spec.artifact.sha256,
        size: input.spec.artifact.size,
      },
      { kind: "activate_release", releaseDirectory: input.spec.target.releaseDirectory, version: input.spec.artifact.version, expectedCurrentVersion: input.probe.snapshot.currentVersion ?? "" },
      ...(input.spec.enableOnBoot ? [{ kind: "systemd", operation: "enable", unit: input.spec.target.unit } as const] : []),
      { kind: "systemd", operation: input.probe.snapshot.activeState === "active" ? "restart" : "start", unit: input.spec.target.unit },
    ];
    const checks = input.spec.healthChecks?.length ? input.spec.healthChecks : [{ kind: "systemd-active", unit: input.spec.target.unit } as const];
    const verify = checks.map(actionHealth);
    // Rollback does not delete an artifact. Keeping immutable releases permits
    // an operator to inspect and retry safely; activation is the reversible bit.
    const rollback: DeploymentAction[] = [
      ...(input.probe.snapshot.currentVersion
        ? [{ kind: "activate_release", releaseDirectory: input.spec.target.releaseDirectory, version: input.probe.snapshot.currentVersion, expectedCurrentVersion: input.spec.artifact.version } as const]
        : []),
      { kind: "systemd", operation: input.probe.snapshot.activeState === "active" ? "restart" : "stop", unit: input.spec.target.unit },
    ];
    return {
      id: input.id,
      provider: this.provider,
      serviceId: input.spec.serviceId,
      targetId: input.spec.target.id,
      state: "awaiting_approval",
      version: input.spec.artifact.version,
      artifact: {
        release_id: input.spec.artifact.release_id,
        service_id: input.spec.serviceId,
        version: input.spec.artifact.version,
        architecture: input.spec.artifact.architecture,
        sha256: input.spec.artifact.sha256,
        size: input.spec.artifact.size,
      },
      previous: {
        currentVersion: input.probe.snapshot.currentVersion,
        currentArtifact: input.probe.snapshot.currentArtifact,
        activeState: input.probe.snapshot.activeState,
      },
      previousRelease: input.probe.snapshot.currentVersion
        ? releasePath(input.spec.target, input.probe.snapshot.currentVersion)
        : undefined,
      apply,
      verify,
      rollback,
      createdAt: (input.now ?? new Date()).toISOString(),
    };
  }

  apply(plan: DeploymentPlan, approved: boolean): ApplyResult {
    if (!approved) throw new Error("deployment plan requires administrator approval");
    if (plan.state !== "awaiting_approval") throw new Error("deployment plan is no longer applicable");
    return { planId: plan.id, state: "activating", actions: plan.apply.map((action) => ({ ...action })) };
  }

  verify(plan: DeploymentPlan, snapshot: SystemdSnapshot, checks: HealthCheckResult[] = []): VerificationResult {
    const issues: DeploymentIssue[] = [];
    if (!snapshot.available) issues.push(issue("systemd_unavailable", "systemd is not available on this host"));
    if (!snapshot.unitExists) issues.push(issue("unit_missing", `unit ${plan.targetId} does not exist`));
    if (snapshot.activeState !== "active") issues.push(issue("unit_inactive", `unit ${plan.targetId} is not active`));
    if (snapshot.currentVersion && snapshot.currentVersion !== plan.version)
      issues.push(issue("artifact_conflict", `active version ${snapshot.currentVersion} differs from ${plan.version}`));
    for (const result of checks) {
      if (!result.healthy) issues.push(issue("health_check_failed", result.message ?? `health check ${result.check.kind} failed`));
    }
    return { planId: plan.id, state: issues.length ? "failed" : "succeeded", healthy: issues.length === 0, issues, snapshot };
  }

  rollback(plan: DeploymentPlan): RollbackResult {
    if (plan.state !== "awaiting_approval") {
      // A persisted plan keeps its state as awaiting_approval until the Agent
      // starts it. Consumers may still call rollback after a failed verify.
      // This method deliberately does not mutate the plan object.
    }
    return { planId: plan.id, state: "rolling_back", actions: plan.rollback.map((action) => ({ ...action })) };
  }
}

export const systemdDeploymentAdapter = new SystemdDeploymentAdapter();
