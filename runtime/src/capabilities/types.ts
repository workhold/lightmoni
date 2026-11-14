import type { IncomingMessage } from "node:http";
import type { User } from "../shared/types.js";
import type { CapabilityDefinition } from "./descriptor.js";

export const CAPABILITY_SCOPES = [
  "hosts.read", "tasks.read", "tasks.source.read", "tasks.propose",
  "proposals.read",
  "executions.read", "telemetry.catalog.read", "telemetry.query", "alerts.read", "alerts.detail.read",
  "logs.read", "traces.read",
  "deployments.read",
  "deployments.propose",
  "operations.read",
  "operations.propose",
  "agents.read",
  "agents.maintain.propose",
  "dashboards.read", "dashboards.detail.read",
  "code.workspace.read", "code.workspace.detail.read",
  "code.workspace.propose",
  "alerts.incidents.read", "alerts.notifications.read",
  "alerts.statistics.read",
  "alerts.propose",
] as const;
export type CapabilityScope = typeof CAPABILITY_SCOPES[number];
export interface Principal {
  user: User;
  /** Absence retains the legacy human/user subject semantics. */
  subject_type?: "user" | "service";
  owner_user_id?: string;
  scopes: string[];
  /** null explicitly grants all registered hosts; an empty list grants none. */
  host_ids: string[] | null;
  credential_id: string;
  grant_id: string;
  source: "mcp" | "web" | "assistant";
}
export interface SessionAuthority {
  sessionPrincipal(user: User, source: "web" | "assistant"): Principal;
}
export interface ExternalAuthority {
  validate(principal: Principal): void;
  validateGrant?(grantID: string, userID?: string): Principal;
  allowsCapability?(principal: Principal, definition: CapabilityDefinition): boolean;
  authorizeContinuation?(principal: Principal, definition: CapabilityDefinition, input: unknown): void;
  authorizeInvocation?(principal: Principal, definition: CapabilityDefinition, input: unknown): void;
}
export interface CapabilityAuthority extends SessionAuthority, ExternalAuthority {}
export interface AccessAuthority extends CapabilityAuthority {
  authenticate(req: IncomingMessage): Principal;
}
export interface InvocationContext {
  signal: AbortSignal;
  session_id?: string;
}
export interface CapabilityDispatcherContract {
  list(principal: Principal): CapabilitySummary[];
  listPage?(principal: Principal, cursor?: string, pageSize?: number): {tools:CapabilitySummary[];nextCursor?:string};
  invoke(principal: Principal, name:string, input:unknown, context:InvocationContext): Promise<Record<string,any>>;
}
export type CapabilitySummary = Pick<CapabilityDefinition,
  "id"|"version"|"name"|"description"|"inputSchema"|"outputSchema"|"effect"|"risk"|"operationKind"|"idempotencyPolicy">;
