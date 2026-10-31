import type { IncomingMessage } from "node:http";
import type { User } from "../shared/types.js";

export const CAPABILITY_SCOPES = [
  "hosts.read", "tasks.read", "tasks.source.read", "tasks.propose",
  "executions.read", "telemetry.catalog.read", "alerts.read",
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
export interface AccessAuthority {
  authenticate(req: IncomingMessage): Principal;
  validate(principal: Principal): void;
  validateGrant?(grantID: string, userID?: string): Principal;
  sessionPrincipal(user: User, source: "web" | "assistant"): Principal;
}
export interface InvocationContext {
  signal: AbortSignal;
  session_id?: string;
}
export interface CapabilityDispatcherContract {
  list(principal: Principal): {name:string;description:string;inputSchema:Record<string,any>;effect:"read"|"propose"}[];
  invoke(principal: Principal, name:string, input:unknown, context:InvocationContext): Promise<Record<string,any>>;
}
