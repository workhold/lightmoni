import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { id, hash, token } from "../shared/crypto.js";
import type { Context, Dependencies, Module } from "../shared/types.js";
import { fail, HTTPError } from "../shared/http.js";

/**
 * Credentials used by the scripted Agent enrollment flow.
 *
 * This module deliberately does not replace the legacy ingest key.  Existing
 * agents continue using config.key until they are re-enrolled; new routes use
 * audience-scoped credentials and never trust an agent_id supplied by itself.
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
  authenticate(
    req: IncomingMessage,
    agentID: string,
    audience: CredentialAudience,
  ): AgentCredential;
  /** Return true only while an enrollment token can authorize a release download. */
  canDownloadWithEnrollmentToken(token: string): boolean;
}

/** Register the admin enrollment and public Agent exchange endpoints. */
export function registerAgentCredentials(
  deps: Dependencies,
): Module & AgentCredentialStore {
  const { db, router } = deps;
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
      bootstrap_hash TEXT NOT NULL DEFAULT ''
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

  const now = () => new Date();
  const iso = (date: Date) => date.toISOString();
  const admin = (ctx: Context) => deps.auth.requireAdmin(ctx);
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

  router.post("/api/v1/agent-enrollments", async (ctx) => {
    admin(ctx);
    const value = record(await ctx.body());
    const allowed = value.allowed_arch == null ? ["amd64", "arm64"] : value.allowed_arch;
    if (!Array.isArray(allowed) || !allowed.length || allowed.some((a) => !ARCHES.has(a)))
      fail(400, "allowed_arch must contain amd64 or arm64");
    const version = asString(value.version ?? "0.1.0", 64, "version");
    if (!VERSION.test(version)) fail(400, "invalid version");
    const requested = Number(value.expires_in_seconds ?? DEFAULT_ENROLLMENT_SECONDS);
    if (!Number.isSafeInteger(requested) || requested < 60)
      fail(400, "expires_in_seconds must be at least 60");
    const expiresIn = Math.min(requested, MAX_ENROLLMENT_SECONDS);
    const idValue = id();
    const raw = secret("lm_enroll_");
    const created = now();
    const expires = new Date(created.getTime() + expiresIn * 1000);
    const label = value.initial_label_id == null ? "" : asString(value.initial_label_id, 128, "initial_label_id");
    const scopes = cleanScopes(value.scopes);
    const endpointOrigin = origin(value.endpoint_origin ?? deps.externalURL);
    db.run(
      `INSERT INTO agent_enrollments(id,token_hash,endpoint_origin,allowed_arch_json,version,initial_label_id,scopes_json,status,expires_at,created_at,created_by)
       VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
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
      ctx.user.id,
    );
    // The full token is intentionally returned only by this response. The
    // generated command contains no secret and is safe to copy from the UI.
    ctx.json(
      {
        enrollment_id: idValue,
        token_display_once: raw,
        token_expires_at: iso(expires),
        install_command_hint:
          `sh install.sh --endpoint ${endpointOrigin} --release-url ${endpointOrigin}/downloads/agent --version ${version} --enrollment-token-stdin`,
      },
      201,
    );
  });

  router.get("/api/v1/agent-enrollments", (ctx) => {
    admin(ctx);
    ctx.json(
      db.all<any>(
        `SELECT id,status,endpoint_origin,allowed_arch_json,version,initial_label_id,scopes_json,expires_at,created_at,used_at,pending_expires_at,agent_id
         FROM agent_enrollments ORDER BY created_at DESC LIMIT 200`,
      ).map((row) => ({
        ...row,
        allowed_arch: JSON.parse(row.allowed_arch_json),
        scopes: JSON.parse(row.scopes_json),
        allowed_arch_json: undefined,
        scopes_json: undefined,
      })),
    );
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
    const current = now();
    if (Date.parse(row.expires_at) <= current.getTime()) {
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
    if (!row.pending_expires_at || Date.parse(row.pending_expires_at) <= now().getTime())
      fail(401, "pending activation expired");
    if (value.health?.service !== "ready" || value.health?.config_checked !== true)
      fail(400, "health check is required before activation");
    const scopes: CredentialScope[] = JSON.parse(row.scopes_json);
    const credentials: Record<string, string> = {};
    const at = now();
    const expiry = new Date(at.getTime() + 90 * 24 * 60 * 60 * 1000);
    db.transaction(() => {
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
      db.run(
        "UPDATE agent_enrollments SET status='active',used_at=?,bootstrap_hash='' WHERE id=?",
        iso(at),
        row.id,
      );
      // Agent registration still happens through the legacy node route during
      // migration. This table is the source of truth for credential binding.
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
    const used = iso(now());
    db.run("UPDATE agent_credentials SET last_used_at=? WHERE id=?", used, row.id);
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
      `SELECT status,expires_at FROM agent_enrollments WHERE token_hash=?`,
      hash(value),
    );
    return !!row &&
      (row.status === "issued" || row.status === "pending_activation") &&
      Date.parse(row.expires_at) > now().getTime();
  };
  return { has, authenticate, canDownloadWithEnrollmentToken };
}
