import type { Dependencies } from "../shared/types.js";
import { createAgentLifecycleSchema } from "./agent-lifecycle.js";
export function registerCore(deps: Dependencies) {
  const { router, db, cat } = deps;
  createAgentLifecycleSchema(db);
  const visible=async(signal?:AbortSignal)=>(await cat.list(signal)).filter(t=>!["lightmoni_center","lightmoni_agent","lightmoni_sdk"].includes(t.logical_name)).map(t=>t.kind==='metric'&&t.metric_type==='histogram'&&!t.system?{...t,name:t.logical_name}:t);
  router.get("/healthz", (c) => c.json({ status: "ok" }), { public: true });
  router.get("/api/v1/catalog/tables", async (c) =>
    c.json(await visible(c.signal)),
  );
  router.put("/api/v1/catalog/tables/:id", async (c) => {
    const v = await c.body();
    if (
      v.alert_group_id &&
      !db.get("SELECT id FROM alert_groups WHERE id=?", v.alert_group_id)
    )
      c.error(400, "alert group not found");
    if (
      !db.run(
        "UPDATE catalog SET alert_group_id=? WHERE id=?",
        v.alert_group_id ?? "",
        c.params.id,
      ).changes
    )
      c.error(404, "table not found");
    c.json({ ok: true });
  });
  router.post("/api/v1/query", async (c) => {
    const v = await c.body();
    try {
      c.json(await deps.query(v, c.signal));
    } catch (e) {
      c.error(400, e instanceof Error ? e.message : "invalid query");
    }
  });
  router.get("/api/v1/overview", async (c) =>
    c.json({
      tables: await visible(c.signal),
      agent_count: db.get<any>("SELECT count(*) n FROM agents WHERE NOT EXISTS (SELECT 1 FROM agent_lifecycle l WHERE l.agent_id=agents.id AND l.state='removed')")!.n,
      user_count: db.get<any>("SELECT count(*) n FROM users WHERE active=1")!.n,
      key_count: db.get<any>(
        "SELECT count(*) n FROM ingest_keys WHERE active=1",
      )!.n,
    }),
  );
}
