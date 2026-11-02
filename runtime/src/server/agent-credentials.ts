import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { id, hash, token } from "../shared/crypto.js";
import type { Context, Dependencies, Module } from "../shared/types.js";
import { fail, HTTPError } from "../shared/http.js";
import { assertAgentActive, createAgentLifecycleSchema, isAgentRemoved } from "./agent-lifecycle.js";
import { replaceableAgentBinding } from "./agent-hosts.js";

/**
 * Credentials used by the scripted Agent enrollment flow.
 *
 * Agent control credentials belong to a server-reserved registered host.
 * SDK reporting keys are a separate data-plane credential.
 */
export type CredentialAudience = "control" | "data";
export type CredentialScope = "agent.control" | "agent.data";

const MAX_ENROLLMENT_SECONDS = 24 * 60 * 60;
const DEFAULT_ENROLLMENT_SECONDS = 15 * 60;
const MAX_PENDING_SECONDS = 15 * 60;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/;
const ARCHES = new Set(["amd64", "arm64"]);

const record = (v: any): Record<string, any> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) fail(400, "invalid request");
  return v;
};
const asString = (v: unknown, max: number, field: string) => {
  if (typeof v !== "string" || !v.trim() || Buffer.byteLength(v) > max)
    fail(400, `invalid ${field}`);
  return v.trim();
};
const asArch = (v: unknown): "amd64" | "arm64" => {
  if (typeof v !== "string" || !ARCHES.has(v)) fail(400, "invalid arch");
  return v as "amd64" | "arm64";
};
const secret = (prefix: string) => prefix + token();
const safeEqualHash = (a: string, b: string) => {
  const aa = Buffer.from(a), bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
};
const bearer = (req: IncomingMessage) => {
  const value = String(req.headers.authorization ?? "");
  return value.startsWith("Bearer ") ? value.slice(7).trim() : "";
};
const origin = (value: unknown) => {
  if (typeof value !== "string" || !value.trim()) fail(400, "endpoint_origin required");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    fail(400, "invalid endpoint_origin");
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    !parsed.host ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  )
    fail(400, "endpoint_origin must be an origin URL");
  return parsed.origin;
};

export interface AgentCredential {
  credential_id: string;
  agent_id: string;
  audience: CredentialAudience;
  scope: CredentialScope;
  expires_at: string;
  last_used_at: string;
}

export interface AgentCredentialStore {
  has(agentID: string, audience: CredentialAudience): boolean;
  /** Registered identities never fall back to a shared legacy reporting key. */
  registered?(agentID: string): boolean;
  authenticate(
    req: IncomingMessage,
    agentID: string,
    audience: CredentialAudience,
  ): AgentCredential;
  /** Return true only while an enrollment token can authorize a release download. */
  canDownloadWithEnrollmentToken(token: string): boolean;
  /** Issue a one-time token for a trusted server-side deployment workflow. */
  issueEnrollment(input: AgentEnrollmentInput): AgentEnrollmentIssued;
  enrollmentStatus(enrollmentID: string): {
    status: string;
    agent_id: string;
    used_at: string;
  } | undefined;
  /** Invalidate a token after a failed trusted deployment attempt. */
  cancelEnrollment?(enrollmentID: string): void;
}

export interface AgentEnrollmentInput {
  endpoint_origin: string;
  version: string;
  allowed_arch?: string[];
  initial_label_id?: string;
  scopes?: CredentialScope[];
  expires_in_seconds?: number;
  created_by: string;
  /** Trusted server-side installation reservation; never accepted from clients. */
  machine_id: string;
  /** The exact retired identity reviewed in the installation plan. */
  previous_agent_id?: string;
  /** Internal installation attempt; created and bound in the same transaction. */
  deployment_id?: string;
}

export interface AgentEnrollmentIssued {
  enrollment_id: string;
  token_display_once: string;
  token_expires_at: string;
  install_command_hint: string;
}

/** Register the admin enrollment and public Agent exchange endpoints. */
export function registerAgentCredentials(
  deps: Dependencies,
): Module & AgentCredentialStore {
  const { db, router } = deps;
  createAgentLifecycleSchema(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_enrollments(
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      endpoint_origin TEXT NOT NULL,
      allowed_arch_json TEXT NOT NULL,
      version TEXT NOT NULL,
      initial_label_id TEXT NOT NULL DEFAULT '',
      scopes_json TEXT NOT NULL,
      status TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL,
      used_at TEXT,
      install_nonce TEXT NOT NULL DEFAULT '',
      agent_id TEXT NOT NULL DEFAULT '',
      agent_public_key TEXT NOT NULL DEFAULT '',
      pending_expires_at TEXT,
      bootstrap_hash TEXT NOT NULL DEFAULT '',
      machine_id TEXT NOT NULL DEFAULT '',replaces_agent_id TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS agent_enrollments_agent ON agent_enrollments(agent_id);
    CREATE TABLE IF NOT EXISTS agent_credentials(
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      audience TEXT NOT NULL,
      scope TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      last_used_at TEXT NOT NULL DEFAULT '',
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      grace_until TEXT,
      revoke_reason TEXT NOT NULL DEFAULT '',
      UNIQUE(agent_id,audience,token_hash)
    );
    CREATE INDEX IF NOT EXISTS agent_credentials_lookup ON agent_credentials(agent_id,audience);
  `);
  const now = () => deps.now?.() ?? new Date();
  const iso = (date: Date) => date.toISOString();
  const admin = (ctx: Context) => deps.auth.requireAdmin(ctx);
  const effectiveEnrollmentStatus = (row: {
    status: string;
    expires_at: string;
    pending_expires_at?: string | null;
  }, at = now().getTime()): string => {
    if (row.status !== "issued" && row.status !== "pending_activation") return row.status;
    if (Date.parse(row.expires_at) <= at ||
      (row.status === "pending_activation" &&
        (!row.pending_expires_at || Date.parse(row.pending_expires_at) <= at)))
      return "expired";
    return row.status;
  };
  const validHostReservation = (row: { machine_id?: string; agent_id?: string; status?: string; replaces_agent_id?: string }) => {
    if (!row.machine_id || !db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='managed_machines'")) return false;
    const machine = db.get<{agent_id:string}>("SELECT agent_id FROM managed_machines WHERE id=?", row.machine_id);
    if (!machine) return false;
    if (row.status === "active") return Boolean(row.agent_id && machine.agent_id === row.agent_id);
    return machine.agent_id === (row.replaces_agent_id || "") && replaceableAgentBinding(db, machine.agent_id, iso(now()));
  };
  const requireHostReservation = (row: { machine_id?: string; agent_id?: string; status?: string; replaces_agent_id?: string }, status = 409) => {
    if (!validHostReservation(row)) fail(status, "registered_host_required: 请先登记主机，再从主机管理部署 Agent");
  };
  const cleanScopes = (value: unknown): CredentialScope[] => {
    const scopes = value == null ? ["agent.control", "agent.data"] : value;
    if (
      !Array.isArray(scopes) ||
      scopes.length < 1 ||
      scopes.some((scope) => scope !== "agent.control" && scope !== "agent.data")
    )
      fail(400, "scopes must contain agent.control or agent.data");
    const unique = [...new Set(scopes)] as CredentialScope[];
    // The current installer and Agent configuration require both audiences.
    // Keep the API from creating an active node that can never write a valid
    // config; narrower scoped enrollment can be added with a matching client
    // contract when credential rotation is implemented.
    if (!unique.includes("agent.control") || !unique.includes("agent.data"))
      fail(400, "enrollment currently requires both control and data scopes");
    return unique;
  };

  const issueEnrollment = (input: AgentEnrollmentInput): AgentEnrollmentIssued => {
    const allowed = input.allowed_arch == null ? ["amd64", "arm64"] : input.allowed_arch;
    if (!Array.isArray(allowed) || !allowed.length || allowed.some((a) => !ARCHES.has(a)))
      fail(400, "allowed_arch must contain amd64 or arm64");
    const version = asString(input.version ?? "0.1.0", 64, "version");
    if (!VERSION.test(version)) fail(400, "invalid version");
    const requested = Number(input.expires_in_seconds ?? DEFAULT_ENROLLMENT_SECONDS);
    if (!Number.isSafeInteger(requested) || requested < 60)
      fail(400, "expires_in_seconds must be at least 60");
    const expiresIn = Math.min(requested, MAX_ENROLLMENT_SECONDS);
    const idValue = id();
    const raw = secret("lm_enroll_");
    const created = now();
    const expires = new Date(created.getTime() + expiresIn * 1000);
    const label = input.initial_label_id == null || input.initial_label_id === "" ? "" : asString(input.initial_label_id, 128, "initial_label_id");
    const scopes = cleanScopes(input.scopes);
    const endpointOrigin = origin(input.endpoint_origin ?? deps.externalURL);
    const machineID = asString(input.machine_id, 64, "machine_id");
    const previousAgentID = input.previous_agent_id == null || input.previous_agent_id === "" ? "" : asString(input.previous_agent_id, 256, "previous_agent_id");
    const deploymentID = input.deployment_id == null ? "" : asString(input.deployment_id,64,"deployment_id");
    db.transaction(() => {
      const machine = db.get<{agent_id:string}>("SELECT agent_id FROM managed_machines WHERE id=?", machineID);
      if (!machine || machine.agent_id !== previousAgentID || !replaceableAgentBinding(db, machine.agent_id, iso(created))) fail(409, "安装目标主机不存在、Agent 身份已变化或尚未撤销");
      if (deploymentID && !db.get("SELECT id FROM machine_deployments WHERE id=? AND machine_id=? AND status='running' AND execution_stage='enrollment_issuing' AND resolved_at=''",deploymentID,machineID)) fail(409,"安装记录已进入恢复流程，禁止旧请求签发身份");
      db.run(
        `INSERT INTO agent_enrollments(id,token_hash,endpoint_origin,allowed_arch_json,version,initial_label_id,scopes_json,status,expires_at,created_at,created_by,machine_id,replaces_agent_id)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        idValue,
        hash(raw),
        endpointOrigin,
        JSON.stringify([...new Set(allowed)]),
        version,
        label,
        JSON.stringify(scopes),
        "issued",
        iso(expires),
        iso(created),
        input.created_by,
        machineID,
        machine.agent_id,
      );
      if (deploymentID) db.run("UPDATE machine_deployments SET enrollment_id=?,execution_stage='enrollment_issued' WHERE id=?",idValue,deploymentID);
    });
    return {
      enrollment_id: idValue,
      token_display_once: raw,
      token_expires_at: iso(expires),
      install_command_hint:
        `sh install.sh --endpoint ${endpointOrigin} --release-url ${endpointOrigin}/downloads/agent --version ${version} --enrollment-token-stdin`,
    };
  };

  router.post("/api/v1/agent-enrollments", async (ctx) => {
    admin(ctx);
    fail(409, "请先登记主机，再从主机管理部署 Agent；不再签发独立脚本接入令牌");
  });

  router.get("/api/v1/agent-enrollments", (ctx) => {
    admin(ctx);
    const at = now().getTime();
    ctx.json(
      db.all<any>(
        `SELECT id,status,endpoint_origin,allowed_arch_json,version,initial_label_id,scopes_json,expires_at,created_at,used_at,pending_expires_at,agent_id
         FROM agent_enrollments ORDER BY created_at DESC LIMIT 200`,
      ).map((row) => ({
        ...row,
        status: effectiveEnrollmentStatus(row, at),
        allowed_arch: JSON.parse(row.allowed_arch_json),
        scopes: JSON.parse(row.scopes_json),
        allowed_arch_json: undefined,
        scopes_json: undefined,
      })),
    );
  });

  router.post("/api/v1/agent-enrollments/:id/revoke", (ctx) => {
    admin(ctx);
    db.transaction(() => {
      const row = db.get<any>(
        "SELECT status,expires_at,pending_expires_at FROM agent_enrollments WHERE id=?",
        ctx.params.id,
      );
      if (!row) fail(404, "enrollment token not found");
      const status = effectiveEnrollmentStatus(row);
      if (status === "cancelled") return;
      if (status !== "issued" && status !== "pending_activation")
        fail(409, "only an unexpired, unused enrollment token can be revoked");
      db.run(
        "UPDATE agent_enrollments SET status='cancelled',bootstrap_hash='' WHERE id=?",
        ctx.params.id,
      );
    });
    ctx.json({ ok: true });
  });

  router.get("/api/v1/agent-credentials", (ctx) => {
    admin(ctx);
    const at = now().getTime();
    ctx.json(db.all<any>(
      `SELECT id,agent_id,audience,scope,created_at,last_used_at,expires_at,revoked_at,revoke_reason
       FROM agent_credentials ORDER BY created_at DESC,id DESC LIMIT 200`,
    ).map((row) => ({
      ...row,
      status: row.revoked_at ? "revoked" : Date.parse(row.expires_at) <= at ? "expired" : "active",
    })));
  });

  // The installer has no browser session. The enrollment token in the request
  // body is the authentication boundary for this one-time exchange.
  router.post("/api/v1/agents/enroll", async (ctx) => {
    const value = record(await ctx.body());
    const enrollToken = asString(value.enrollment_token, 512, "enrollment_token");
    const nonce = asString(value.install_nonce, 256, "install_nonce");
    const publicKey = asString(value.agent_public_key, 4096, "agent_public_key");
    const version = asString(value.version, 64, "version");
    const arch = asArch(value.arch);
    const row = db.get<any>("SELECT * FROM agent_enrollments WHERE token_hash=?", hash(enrollToken));
    if (!row) fail(401, "invalid enrollment token");
    requireHostReservation(row);
    const current = now();
    if (effectiveEnrollmentStatus(row, current.getTime()) === "expired") {
      db.run("UPDATE agent_enrollments SET status='expired' WHERE id=? AND status='issued'", row.id);
      fail(401, "enrollment token expired");
    }
    if (row.status === "pending_activation") {
      if (row.install_nonce === nonce) {
        // The first response may have been lost after the center committed the
        // pending binding. Rotate the one-use bootstrap secret so the same
        // nonce can safely resume without ever storing or replaying plaintext.
        const resumedBootstrap = secret("lm_bootstrap_");
        db.run(
          "UPDATE agent_enrollments SET bootstrap_hash=? WHERE id=? AND status='pending_activation'",
          hash(resumedBootstrap),
          row.id,
        );
        ctx.json({
          enrollment_id: row.id,
          agent_id: row.agent_id,
          bootstrap_credential: resumedBootstrap,
          pending_expires_at: row.pending_expires_at,
          resumed: true,
        });
        return;
      }
      fail(409, "enrollment token already used");
    }
    if (row.status !== "issued") fail(409, "enrollment token is unavailable");
    const allowed: string[] = JSON.parse(row.allowed_arch_json);
    if (!allowed.includes(arch) || row.version !== version)
      fail(400, "version or architecture is not allowed");
    const agentID = id();
    const bootstrap = secret("lm_bootstrap_");
    const pending = new Date(current.getTime() + MAX_PENDING_SECONDS * 1000);
    db.transaction(() => {
      // The token is consumed atomically; two installers cannot bind the same session.
      const changed = db.run(
        `UPDATE agent_enrollments SET status='pending_activation',install_nonce=?,agent_id=?,agent_public_key=?,pending_expires_at=?,bootstrap_hash=?
         WHERE id=? AND status='issued'`,
        nonce,
        agentID,
        publicKey,
        iso(pending),
        hash(bootstrap),
        row.id,
      ).changes;
      if (!changed) fail(409, "enrollment token already used");
    });
    ctx.json({
      enrollment_id: row.id,
      agent_id: agentID,
      bootstrap_credential: bootstrap,
      pending_expires_at: iso(pending),
    }, 201);
  }, { public: true });

  // Activation is similarly authenticated by the short-lived bootstrap
  // credential, so it must be reachable by an installer without a cookie.
  router.post("/api/v1/agents/:id/activate", async (ctx) => {
    const value = record(await ctx.body());
    const nonce = asString(value.install_nonce, 256, "install_nonce");
    const authorization = bearer(ctx.req);
    if (!authorization) fail(401, "bootstrap credential required");
    const row = db.get<any>(
      "SELECT * FROM agent_enrollments WHERE agent_id=? AND status='pending_activation'",
      ctx.params.id,
    );
    if (!row || row.install_nonce !== nonce || !safeEqualHash(row.bootstrap_hash, hash(authorization)))
      fail(401, "invalid bootstrap credential");
    requireHostReservation(row);
    if (effectiveEnrollmentStatus(row) === "expired")
      fail(401, "pending activation expired");
    if (value.health?.service !== "ready" || value.health?.config_checked !== true)
      fail(400, "health check is required before activation");
    const scopes: CredentialScope[] = JSON.parse(row.scopes_json);
    const credentials: Record<string, string> = {};
    const at = now();
    const expiry = new Date(at.getTime() + 90 * 24 * 60 * 60 * 1000);
    db.transaction(() => {
      assertAgentActive(db, row.agent_id, 401);
      requireHostReservation(row);
      const changed = db.run(
        `UPDATE agent_enrollments SET status='active',used_at=?,bootstrap_hash=''
         WHERE id=? AND status='pending_activation' AND bootstrap_hash=? AND expires_at>? AND pending_expires_at>?`,
        iso(at),
        row.id,
        row.bootstrap_hash,
        iso(at),
        iso(at),
      ).changes;
      if (!changed) fail(401, "bootstrap credential is unavailable");
      for (const scope of scopes) {
        const audience: CredentialAudience = scope === "agent.control" ? "control" : "data";
        const value = secret(`lm_agent_${audience}_`);
        credentials[audience + "_credential"] = value;
        db.run(
          `INSERT INTO agent_credentials(id,agent_id,audience,scope,token_hash,created_at,expires_at)
           VALUES(?,?,?,?,?,?,?)`,
          id(),
          row.agent_id,
          audience,
          scope,
          hash(value),
          iso(at),
          iso(expiry),
        );
      }
      // Activation claims the reserved host in the same writer transaction.
      // Concurrent tokens cannot activate different identities on one host.
      const claimed = db.run("UPDATE managed_machines SET agent_id=?,agent_last_seen='',observed_hostname='' WHERE id=? AND agent_id=?", row.agent_id, row.machine_id, row.replaces_agent_id);
      if (!claimed.changes) fail(409, "registered_host_required: 安装目标身份已变化");
      // Registration subsequently records this Agent's observed host metadata;
      // the replaced Agent's hostname must not cross the activation boundary.
    });
    ctx.json({
      agent_id: row.agent_id,
      ...credentials,
      credential_expires_at: iso(expiry),
    });
  }, { public: true });

  router.post("/api/v1/agents/:id/credentials/revoke", async (ctx) => {
    admin(ctx);
    const value = record(await ctx.body());
    const reason = value.reason == null ? "administrator revoked" : asString(value.reason, 512, "reason");
    const audience = value.audience == null ? undefined : value.audience;
    if (audience !== undefined && audience !== "control" && audience !== "data")
      fail(400, "invalid audience");
    const result = db.run(
      `UPDATE agent_credentials SET revoked_at=?,revoke_reason=? WHERE agent_id=? AND revoked_at IS NULL${audience ? " AND audience=?" : ""}`,
      iso(now()),
      reason,
      ctx.params.id,
      ...(audience ? [audience] : []),
    );
    ctx.json({ agent_id: ctx.params.id, revoked: result.changes });
  });

  const authenticate = (
    req: IncomingMessage,
    agentID: string,
    audience: CredentialAudience,
  ): AgentCredential => {
    assertAgentActive(db, agentID, 401);
    const value = bearer(req);
    if (!value) throw new HTTPError(401, "agent credential required");
    const row = db.get<any>(
      `SELECT id,agent_id,audience,scope,expires_at,last_used_at,revoked_at FROM agent_credentials
       WHERE agent_id=? AND audience=? AND token_hash=?`,
      agentID,
      audience,
      hash(value),
    );
    if (!row || row.revoked_at || Date.parse(row.expires_at) <= now().getTime())
      throw new HTTPError(401, "invalid agent credential");
    const enrollment = db.get<any>("SELECT machine_id,agent_id,status FROM agent_enrollments WHERE agent_id=? AND status='active' ORDER BY created_at DESC LIMIT 1", agentID);
    if (!enrollment) fail(401, "registered_host_required: Agent 必须由已登记主机部署");
    requireHostReservation(enrollment, 401);
    const used = iso(now());
    const changed = db.run("UPDATE agent_credentials SET last_used_at=? WHERE id=? AND revoked_at IS NULL AND NOT EXISTS (SELECT 1 FROM agent_lifecycle WHERE agent_id=? AND state='removed')", used, row.id, agentID);
    if (!changed.changes) throw new HTTPError(401, "invalid agent credential");
    return {
      credential_id: row.id,
      agent_id: row.agent_id,
      audience: row.audience,
      scope: row.scope,
      expires_at: row.expires_at,
      last_used_at: used,
    };
  };
  const has = (agentID: string, audience: CredentialAudience) => {
    if (isAgentRemoved(db, agentID)) return false;
    const enrollment = db.get<any>("SELECT machine_id,agent_id,status FROM agent_enrollments WHERE agent_id=? AND status='active' ORDER BY created_at DESC LIMIT 1", agentID);
    if (!enrollment || !validHostReservation(enrollment)) return false;
    const row = db.get<any>(
      `SELECT 1 FROM agent_credentials
       WHERE agent_id=? AND audience=? AND revoked_at IS NULL AND expires_at>? LIMIT 1`,
      agentID,
      audience,
      iso(now()),
    );
    return !!row;
  };
  const canDownloadWithEnrollmentToken = (value: string) => {
    if (!value || Buffer.byteLength(value) > 512) return false;
    const row = db.get<any>(
      `SELECT status,expires_at,pending_expires_at,machine_id,agent_id,replaces_agent_id FROM agent_enrollments WHERE token_hash=?`,
      hash(value),
    );
    if (!row || !validHostReservation(row)) return false;
    const status = effectiveEnrollmentStatus(row);
    return status === "issued" || status === "pending_activation";
  };
  const enrollmentStatus = (enrollmentID: string) => {
    const row = db.get<any>(
      "SELECT status,agent_id,machine_id,replaces_agent_id,COALESCE(used_at,'') AS used_at,expires_at,pending_expires_at FROM agent_enrollments WHERE id=?",
      enrollmentID,
    );
    return row && {
      status: validHostReservation(row) ? effectiveEnrollmentStatus(row) : "unavailable",
      agent_id: row.agent_id,
      used_at: row.used_at,
    };
  };
  const cancelEnrollment = (enrollmentID: string) => {
    db.run(
      "UPDATE agent_enrollments SET status='cancelled' WHERE id=? AND status IN ('issued','pending_activation')",
      enrollmentID,
    );
  };
  const registered = (agentID: string) => Boolean(db.get("SELECT agent_id FROM agent_lifecycle WHERE agent_id=?", agentID) || db.get("SELECT id FROM agent_credentials WHERE agent_id=? LIMIT 1", agentID) || db.get("SELECT id FROM agent_enrollments WHERE agent_id=? LIMIT 1", agentID));
  return {
    has,
    registered,
    authenticate,
    canDownloadWithEnrollmentToken,
    issueEnrollment,
    enrollmentStatus,
    cancelEnrollment,
  };
}
