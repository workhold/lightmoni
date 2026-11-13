import type { Dependencies, User } from "../shared/types.js";
import { fail } from "../shared/http.js";
import { CAPABILITY_SCOPES, type CapabilityAuthority, type ExternalAuthority, type Principal } from "./types.js";

export function scopesForUser(user: User): string[] {
  return user.role === "admin" ? [...CAPABILITY_SCOPES] : [];
}
function sessionScopesForUser(user: User): string[] {
  if (user.role === "admin") return [...CAPABILITY_SCOPES];
  // These were already available to members through the internal assistant.
  // External PAT/OAuth issuance continues to use scopesForUser and is admin-only.
  return user.role === "member" ? ["telemetry.catalog.read", "telemetry.query"] : [];
}

/** Session identity belongs to the always-on capability core, not MCP configuration. */
export class SessionAccess {
  constructor(readonly deps: Dependencies) {}

  currentUser(userID: string): User {
    const user = this.deps.db.get<User>("SELECT id,name,role FROM users WHERE id=? AND active=1", userID);
    if (!user) fail(401, "能力主体已失效");
    return user;
  }

  sessionPrincipal(user: User, source: "web" | "assistant"): Principal {
    const fresh = this.currentUser(user.id);
    return { user: fresh, scopes: sessionScopesForUser(fresh), host_ids: null, credential_id: "", grant_id: "", source };
  }
}

/** Refresh session principals locally and delegate only external credentials/grants. */
export class CapabilityAccess extends SessionAccess implements CapabilityAuthority {
  constructor(deps: Dependencies, private readonly external?: ExternalAuthority) {
    super(deps);
  }

  validate(principal: Principal): void {
    if (principal.source === "mcp") {
      if (!this.external) fail(503, "外部授权校验不可用");
      this.external.validate(principal);
      return;
    }
    if (principal.credential_id || principal.grant_id) fail(401, "无效的能力主体");
    const fresh = this.sessionPrincipal(principal.user, principal.source);
    Object.assign(principal, fresh);
  }

  validateGrant(grantID: string, userID?: string): Principal {
    if (!this.external?.validateGrant) fail(503, "外部授权校验不可用");
    return this.external.validateGrant(grantID, userID);
  }
}
