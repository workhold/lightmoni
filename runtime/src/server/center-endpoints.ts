import { randomUUID } from "node:crypto";
import type { Dependencies } from "../shared/types.js";
import type { AgentCredentialStore } from "./agent-credentials.js";
import { fail } from "../shared/http.js";
import { hash } from "../shared/crypto.js";

/** All network entrances must use this same durable center identity and DB. */
export function registerCenterEndpoints(d: Dependencies, settings: () => any, credentials?: AgentCredentialStore) {
  d.db.run("INSERT OR IGNORE INTO instance_settings(name,value) VALUES('center_id',?)", randomUUID());
  const centerID = d.db.get<{ value: string }>("SELECT value FROM instance_settings WHERE name='center_id'")!.value;
  d.router.get("/v1/center-identity", c => {
    c.res.setHeader("cache-control", "no-store");
    c.json({ center_id: centerID });
  }, { public: true });
  d.router.get("/v1/center-endpoints", c => {
    const agentID = String(c.req.headers["x-lightmoni-agent-id"] ?? "");
    if (agentID) {
      if (!credentials) fail(401, "agent control credential required");
      credentials.authenticate(c.req, agentID, "control");
    } else d.auth.validateKey(c, undefined, true);
    const endpoints = settings().endpoints.map((e: any) => ({ url: e.url, scope: e.scope ?? "public" }));
    c.res.setHeader("cache-control", "no-store");
    c.json({ version: 1, center_id: centerID, revision: hash(JSON.stringify(endpoints)), endpoints, refresh_after_seconds: 30 });
  }, { public: true });
}
