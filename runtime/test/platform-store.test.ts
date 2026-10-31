import { test } from "node:test";
import assert from "node:assert/strict";
import { DB } from "../src/shared/sqlite.js";
import { cipher } from "../src/shared/crypto.js";
import { Router } from "../src/shared/http.js";
import { registerAgentJobs } from "../src/server/agent-jobs.js";
import { OperationsPlatformStore } from "../src/ops/store.js";
import type { Dependencies } from "../src/shared/types.js";
function setup(t: any) {
  const db = new DB(":memory:");
  db.exec(
    "CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT,active INTEGER);INSERT INTO users VALUES('admin','admin',1),('member','member',1);CREATE TABLE agents(id TEXT PRIMARY KEY);INSERT INTO agents VALUES('node-a')",
  );
  const deps = {
    db,
    router: new Router(),
    ...cipher(Buffer.alloc(32, 9)),
    now: () => new Date("2026-10-29T02:00:00Z"),
    logger: { info() {}, warn() {}, error() {} },
  } as unknown as Dependencies;
  const jobs = registerAgentJobs(deps, { agentCredentials: { has: () => true } as any }),
    store = new OperationsPlatformStore(deps, jobs);
  store.register("application", {
    validate: (s) => s,
    publicSpec: (s) => ({ image: s.image, has_environment: !!s.environment }),
  });
  t.after(() => {
    store.close();
    jobs.close?.();
    db.close();
  });
  return { db, deps, jobs, store };
}
test("center restart preserves ordered execution steps, marks an interrupted run unknown and does not replay work", async t => {
  const f=setup(t),resource=f.store.create('application','Restart fixture',{},'admin');
  const old=await f.store.run(resource,'inspect','admin',async()=>({verified:true}));
  f.store.addRunEvent(old.id,'dns_prepare','succeeded',{domain:'example.test',attempt:1,private_key_pem:'never-persist'});
  f.db.run("UPDATE ops_platform_runs SET state='running' WHERE id=?",old.id);
  const restarted=new OperationsPlatformStore(f.deps,f.jobs);
  t.after(()=>restarted.close());
  assert.equal(restarted.action(old.id).state,'unknown');
  const events=restarted.runEvents(old.id);
  assert.deepEqual(events.map(e=>e.sequence),[1,2]);
  assert.equal(events[1].phase,'interrupted');assert.equal(events[1].state,'unknown');
  assert.equal(events[0].domain,'example.test');
  assert.doesNotMatch(JSON.stringify(f.db.all('SELECT * FROM ops_platform_run_events')),/never-persist/);
  assert.equal(restarted.actions(resource.id).length,1);
});
test("global revisions encrypt secrets and recheck actor and revision", (t) => {
  const { db, store } = setup(t);
  assert.throws(
    () => store.create("application", "Denied", {}, "member"),
    /authorization/,
  );
  const r = store.create(
    "application",
    "App",
    { image: "example:1", environment: { PASSWORD: "test-private" } },
    "admin",
  );
  assert.equal(
    JSON.stringify(db.all("SELECT * FROM ops_platform_resources")).includes(
      "test-private",
    ),
    false,
  );
  assert.equal(JSON.stringify(store.public(r)).includes("test-private"), false);
  assert.equal(
    store.update(r.id, 1, "App", { image: "example:2" }, "admin").revision,
    2,
  );
  assert.throws(() => store.update(r.id, 1, "App", {}, "admin"), /revision/);
  assert.equal(db.all("SELECT * FROM ops_platform_revisions").length, 2);
});
test("job and encrypted payload commit atomically with persistent dispatch deduplication", (t) => {
  const { db, store, jobs } = setup(t),
    r = store.create("application", "App", {}, "admin"),
    config = {
      task: "workload.apply",
      environment: { PASSWORD: "payload-private" },
    };
  const first = store.queue(r, "node-a", "deploy", config, "admin", "app-v1"),
    second = store.queue(r, "node-a", "deploy", config, "admin", "app-v1");
  assert.equal(first.id, second.id);
  assert.equal(db.get<any>("SELECT COUNT(*) n FROM agent_jobs")!.n, 1);
  assert.equal(
    JSON.stringify(jobs.get(first.job_id)).includes("payload-private"),
    false,
  );
  assert.equal(
    JSON.stringify(db.all("SELECT * FROM ops_platform_runs")).includes(
      "payload-private",
    ),
    false,
  );
  const job = jobs.claim("node-a", ["operations.platform"])!;
  assert.equal(
    store.resolvePayload(job).resource.config.environment.PASSWORD,
    "payload-private",
  );
  db.run("UPDATE users SET active=0 WHERE id='admin'");
  assert.throws(() => store.resolvePayload(job), /authorization/);
});
test("failed storage allocation rolls back its job rather than leaving an orphan", (t) => {
  const { db, store } = setup(t),
    r = store.create("application", "App", {}, "admin");
  db.exec(
    "CREATE TRIGGER reject_platform_run BEFORE INSERT ON ops_platform_runs BEGIN SELECT RAISE(ABORT, 'simulated storage failure'); END;",
  );
  assert.throws(
    () =>
      store.queue(r, "node-a", "deploy", { task: "workload.apply" }, "admin"),
    /storage failure/,
  );
  assert.equal(db.get<any>("SELECT COUNT(*) n FROM agent_jobs")!.n, 0);
});
test("unclaimed old revisions are cancelled and mismatched receipts cannot succeed", (t) => {
  const { store, jobs } = setup(t),
    r = store.create("application", "App", {}, "admin");
  const old = store.queue(
    r,
    "node-a",
    "deploy",
    { task: "workload.apply" },
    "admin",
  );
  const updated = store.update(r.id, 1, "App", {}, "admin");
  assert.equal(jobs.get(old.job_id).state, "cancelled");
  assert.equal(jobs.claim("node-a", ["operations.platform"]), null);
  const run = store.queue(
      updated,
      "node-a",
      "deploy",
      { task: "workload.apply" },
      "admin",
    ),
    job = jobs.claim("node-a", ["operations.platform"])!;
  for (const [i, phase] of [
    "accepted",
    "staging",
    "activating",
    "verifying",
  ].entries())
    jobs.event("node-a", job.id, {
      lease_id: job.lease_id,
      sequence: i + 1,
      phase,
      summary: "phase",
    });
  jobs.result("node-a", job.id, {
    lease_id: job.lease_id,
    state: "succeeded",
    summary: "bad receipt",
    snapshot: {
      health: { healthy: true },
      operations: { operation_id: run.id, resource_id: "wrong" },
    },
  });
  assert.equal(store.actions()[0].state, "unknown");
});
test("verified receipts update runs and observers retain private execution identity", (t) => {
  const { store, jobs } = setup(t),
    r = store.create("application", "App", {}, "admin");
  let observed: any;
  store.subscribe((run, config) => {
    observed = { run, config };
  });
  const run = store.queue(
      r,
      "node-a",
      "inspect",
      { task: "workload.inspect", instance_id: "instance-1" },
      "admin",
    ),
    job = jobs.claim("node-a", ["operations.platform"])!;
  for (const [i, phase] of [
    "accepted",
    "staging",
    "activating",
    "verifying",
  ].entries())
    jobs.event("node-a", job.id, {
      lease_id: job.lease_id,
      sequence: i + 1,
      phase,
      summary: "phase",
    });
  jobs.result("node-a", job.id, {
    lease_id: job.lease_id,
    state: "succeeded",
    summary: "verified",
    snapshot: {
      health: { healthy: true },
      operations: {
        operation_id: run.id,
        resource_id: r.id,
        data: { healthy: true, environment: { secret: "should-not-return" } },
      },
    },
  });
  assert.equal(store.actions()[0].state, "succeeded");
  assert.equal(observed.config.instance_id, "instance-1");
  assert.equal(observed.run.result.healthy, true);
  assert.equal(
    JSON.stringify(store.actions()).includes("should-not-return"),
    false,
  );
});
test("unknown cloud writes persist without replay or raw errors", async (t) => {
  const { store } = setup(t),
    r = store.create("application", "App", {}, "admin");
  let writes = 0;
  const perform = () =>
    store.run(
      r,
      "cloud.deploy",
      "admin",
      async () => {
        writes++;
        throw Object.assign(Error("private vendor body"), {
          state: "unknown",
          code: "cloud_result_unknown",
        });
      },
      "cert-version-target",
    );
  const first = await perform(),
    second = await perform();
  assert.equal(first.state, "unknown");
  assert.equal(first.id, second.id);
  assert.equal(writes, 1);
  assert.equal(
    JSON.stringify(store.actions()).includes("private vendor body"),
    false,
  );
});
test("resource references block deletion while audit revisions remain", (t) => {
  const { db, store } = setup(t),
    a = store.create("application", "First", {}, "admin"),
    b = store.create(
      "application",
      "Second",
      { application_id: a.id },
      "admin",
    );
  assert.throws(() => store.remove(a.id, 1), /in_use/);
  store.remove(b.id, 1);
  store.remove(a.id, 1);
  assert.equal(store.list().length, 0);
  assert.equal(db.all("SELECT * FROM ops_platform_revisions").length, 2);
});

test("claimed jobs block editing even before the first Agent phase event", (t) => {
  const { store, jobs } = setup(t),
    r = store.create("application", "App", {}, "admin");
  store.queue(r, "node-a", "deploy", { task: "workload.apply" }, "admin");
  jobs.claim("node-a", ["operations.platform"]);
  assert.throws(() => store.update(r.id, 1, "App", {}, "admin"), /busy/);
});

test("internal references and reconciliation inventory are not truncated by UI limits", (t) => {
  const { db, store } = setup(t),
    parent = store.create("application", "Parent", {}, "admin"),
    dependent = store.create(
      "application",
      "Dependent",
      { application_id: parent.id },
      "admin",
    );
  for (let n = 0; n < 1000; n++)
    store.create("application", "Other " + n, {}, "admin");
  db.run(
    "UPDATE ops_platform_resources SET updated_at=? WHERE id=?",
    "2000-01-01T00:00:00Z",
    dependent.id,
  );
  assert.equal(store.list().length, 1002);
  assert.throws(() => store.remove(parent.id, 1), /in_use/);
});

test("completed centre verification observations do not permanently lock later edits", async (t) => {
  const { store } = setup(t),
    r = store.create("application", "App", {}, "admin");
  const first = await store.run(r, "cloud.sync", "admin", async () => ({
    state: "verifying",
    verified: false,
  }));
  assert.equal(first.state, "verifying");
  await store.run(r, "cloud.inspect", "admin", async () => ({
    verified: true,
  }));
  const updated = store.update(r.id, 1, r.name, {}, "admin");
  assert.equal(updated.revision, 2);
  store.remove(r.id, 2);
  assert.equal(store.list().length, 0);
});
test("shutdown rejects newly arriving work and waits for work already in progress", async (t) => {
  const { store } = setup(t),
    r = store.create("application", "App", {}, "admin");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const running = store.run(r, "cloud.sync", "admin", async () => {
    await gate;
    return { verified: true };
  });
  let closed = false;
  const closing = store.close().then(() => {
    closed = true;
  });
  await assert.rejects(
    store.run(r, "other", "admin", async () => ({ verified: true })),
    /shutting_down/,
  );
  assert.throws(
    () => store.create("application", "Late", {}, "admin"),
    /shutting_down/,
  );
  assert.equal(closed, false);
  release();
  assert.equal((await running).state, "succeeded");
  await closing;
  assert.equal(closed, true);
});
