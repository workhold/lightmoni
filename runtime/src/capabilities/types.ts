import type { IncomingMessage } from "node:http";
import type { User } from "../shared/types.js";
import type { CapabilityDefinition } from "./descriptor.js";

export const CAPABILITY_SCOPES = [
  "hosts.read", "tasks.read", "tasks.source.read", "tasks.propose",
  "executions.read", "telemetry.catalog.read", "telemetry.query", "alerts.read", "alerts.detail.read",
  "logs.read", "traces.read",
  "deployments.read",
  "operations.read",
  "agents.read",
  "dashboards.read", "dashboards.detail.read",
] as const;
export type CapabilityScope = typeof CAPABILITY_SCOPES[number];
export interface Principal {
  user: User;
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
