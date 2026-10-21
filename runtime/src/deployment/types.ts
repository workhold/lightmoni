/**
 * Domain types shared by deployment providers.
 *
 * Providers intentionally describe work as typed actions instead of shell
 * strings.  The Agent can execute the actions from a capability allow-list,
 * while the control plane can review and persist the complete plan first.
 */

export const DEPLOYMENT_STATES = [
  "draft",
  "preflight",
  "awaiting_approval",
  "agent_ready",
  "staging",
  "activating",
  "verifying",
  "succeeded",
  "failed",
  "rollback_pending",
  "rolling_back",
  "rolled_back",
] as const;
export type DeploymentState = (typeof DEPLOYMENT_STATES)[number];

export type DeploymentAction =
  | {
      kind: "stage_artifact";
      source: string;
      destination: string;
      /** The digest is checked by the Agent before the copy is activated. */
      sha256: string;
    }
  | {
      kind: "activate_release";
      releaseDirectory: string;
      version: string;
    }
  | {
      kind: "systemd";
      operation:
        | "daemon-reload"
        | "enable"
        | "disable"
        | "start"
        | "restart"
        | "stop";
      unit: string;
    }
  | {
      kind: "health_check";
      check: HealthCheck;
    };

export type HealthCheck =
  | { kind: "systemd-active"; unit: string }
  | { kind: "http"; url: string; timeoutMs?: number; expectedStatus?: number }
  | { kind: "tcp"; host: string; port: number; timeoutMs?: number };

export interface DeploymentArtifact {
  /** A content-addressed or otherwise immutable artifact path. */
  source: string;
  version: string;
  sha256: string;
  fileName?: string;
}

export interface ServiceTarget {
  id: string;
  name?: string;
  provider: "systemd";
  unit: string;
  /** Directory controlled by this service. It is never inferred from input. */
  releaseDirectory: string;
  /** The Agent is allowed to stage only under releaseDirectory. */
  enabled?: boolean;
}

export interface ServiceSpec {
  serviceId: string;
  target: ServiceTarget;
  artifact: DeploymentArtifact;
  healthChecks?: HealthCheck[];
  /** If true, the unit is enabled on boot as part of activation. */
  enableOnBoot?: boolean;
}

export interface SystemdSnapshot {
  available: boolean;
  unitExists: boolean;
  activeState: "active" | "inactive" | "failed" | "activating" | "deactivating" | "unknown";
  enabled: boolean | "unknown";
  currentVersion?: string;
  currentArtifact?: string;
}

export interface DeploymentIssue {
  code:
    | "systemd_unavailable"
    | "unit_missing"
    | "unit_inactive"
    | "invalid_target"
    | "invalid_artifact"
    | "artifact_conflict"
    | "health_check_failed"
    | "snapshot_missing";
  message: string;
}

export interface ProbeResult {
  provider: "systemd";
  targetId: string;
  supported: boolean;
  ready: boolean;
  snapshot: SystemdSnapshot;
  issues: DeploymentIssue[];
  observedAt: string;
}

export interface DeploymentPlan {
  id: string;
  provider: "systemd";
  serviceId: string;
  targetId: string;
  state: "awaiting_approval";
  version: string;
  artifact: Pick<DeploymentArtifact, "source" | "version" | "sha256">;
  previous: Pick<SystemdSnapshot, "currentVersion" | "currentArtifact" | "activeState">;
  previousRelease?: string;
  apply: DeploymentAction[];
  verify: DeploymentAction[];
  rollback: DeploymentAction[];
  createdAt: string;
}

export interface ApplyResult {
  planId: string;
  state: "activating";
  actions: DeploymentAction[];
}

export interface VerificationResult {
  planId: string;
  state: "succeeded" | "failed";
  healthy: boolean;
  issues: DeploymentIssue[];
  snapshot: SystemdSnapshot;
}

export interface HealthCheckResult {
  check: HealthCheck;
  healthy: boolean;
  message?: string;
}

export interface RollbackResult {
  planId: string;
  state: "rolling_back";
  actions: DeploymentAction[];
}

export interface DeploymentAdapter {
  readonly provider: "systemd";
  probe(input: { target: ServiceTarget; snapshot: SystemdSnapshot; now?: Date }): ProbeResult;
  plan(input: { id: string; spec: ServiceSpec; probe: ProbeResult; now?: Date }): DeploymentPlan;
  apply(plan: DeploymentPlan, approved: boolean): ApplyResult;
  verify(plan: DeploymentPlan, snapshot: SystemdSnapshot, checks?: HealthCheckResult[]): VerificationResult;
  rollback(plan: DeploymentPlan): RollbackResult;
}
