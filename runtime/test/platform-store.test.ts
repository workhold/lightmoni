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
  const jobs = registerAgentJobs(deps, {
      agentCredentials: { has: () => true } as any,
    }),
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

test("center restart preserves ordered execution steps, marks an interrupted run unknown and does not replay work", async (t) => {
  const f = setup(t),
    resource = f.store.create("application", "Restart fixture", {}, "admin");
  const old = await f.store.run(resource, "inspect", "admin", async () => ({
    verified: true,
  }));
  f.store.addRunEvent(old.id, "dns_prepare", "succeeded", {
    domain: "example.test",
    attempt: 1,
    private_key_pem: "never-persist",
  });
  f.db.run("UPDATE ops_platform_runs SET state='running' WHERE id=?", old.id);
  const restarted = new OperationsPlatformStore(f.deps, f.jobs);
  t.after(() => restarted.close());
  assert.equal(restarted.action(old.id).state, "unknown");
  const events = restarted.runEvents(old.id);
  assert.deepEqual(
    events.map((e) => e.sequence),
    [1, 2],
  );
  assert.equal(events[1].phase, "interrupted");
  assert.equal(events[1].state, "unknown");
  assert.equal(events[0].domain, "example.test");
  assert.doesNotMatch(
    JSON.stringify(f.db.all("SELECT * FROM ops_platform_run_events")),
    /never-persist/,
  );
  assert.equal(restarted.actions(resource.id).length, 1);
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


for(const task of ['node.inspect','instance.recovery.inspect','workload.apply','workload.inspect','workload.stop','workload.remove','workload.logs','gateway.apply','gateway.inspect','gateway.stop','gateway.remove','gateway.logs','certificate.install','certificate.inspect','hook.run','hook.inspect']) {
 test(`removed platform queue rejects ${task} before creating runs, payloads or jobs`,t=>{
  const {db,store}=setup(t),r=store.create('application','App',{},'admin');
  const before=db.all('SELECT * FROM ops_platform_resources');
  db.exec("CREATE TRIGGER qa_no_run BEFORE INSERT ON ops_platform_runs BEGIN SELECT RAISE(ABORT,'run inserted before refusal'); END;");
  assert.throws(()=>store.queue(r,'node-a','deploy',{task,environment:{SECRET:'must-not-persist'}},'admin','stable-request'),e=>(e as any).status===409&&(e as Error).message==='privileged_profile_not_implemented');
  assert.equal(db.get<any>('SELECT COUNT(*) n FROM agent_jobs')!.n,0);
  assert.equal(db.get<any>('SELECT COUNT(*) n FROM ops_platform_runs')!.n,0);
  assert.deepEqual(db.all('SELECT * FROM ops_platform_resources'),before);
 });
}

test('removed private payload lookup does not access jobs, decrypt secrets or notify observers',t=>{
 const {deps,store,jobs}=setup(t);let observed=0;
 store.subscribe(()=>{observed++;});
 deps.decrypt=()=>{throw Error('private payload decrypted');};
 jobs.get=()=>{throw Error('legacy job loaded');};
 assert.throws(()=>store.resolvePayload({id:'untrusted',operation_id:'old'} as any),e=>(e as any).status===410&&(e as Error).message==='legacy_agent_payload_removed');
 assert.equal(observed,0);
});

test('historical ordinary operations retire without private reads or domain callbacks and preserve unknown evidence',async t=>{
 const f=setup(t),r=f.store.create('application','Historical',{},'admin'),at=f.deps.now().toISOString();
 for(const [state,attempts] of [['queued',0],['leased',1],['activating',1]] as const){
  f.db.run(`INSERT INTO agent_jobs(id,agent_id,deployment_id,operation_id,state,capabilities_json,actions_json,target_json,issued_at,expires_at,attempts,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,'job-'+state,'node-a','legacy-'+state,'run-'+state,state,'["operations.platform"]',JSON.stringify([{kind:'operations',operation_id:'run-'+state,domain:'platform'}]),'{}',at,'2099-01-01T00:00:00Z',attempts,at,at);
  f.db.run('INSERT INTO ops_platform_runs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)','run-'+state,r.id,1,'node-a','deploy',state,'unreadable-payload','{}','job-'+state,'admin',null,at,at);
 }
 await f.store.close();f.jobs.close?.();
 let reads=0;const decrypt=f.deps.decrypt;
 f.deps.decrypt=value=>{if(value==='unreadable-payload'){reads++;throw Error('private read');}return decrypt(value);};
 const jobs=registerAgentJobs(f.deps,{agentCredentials:{has:()=>true} as any});t.after(()=>jobs.close?.());
 const store=new OperationsPlatformStore(f.deps,jobs);t.after(()=>store.close());
 let notified=0;store.subscribe(()=>{notified++;});
 for(const [previous,state] of [['queued','cancelled'],['leased','unknown'],['activating','unknown']]){
  const run=store.action('run-'+previous);assert.equal(run.state,state);assert.deepEqual(run.result,{code:'legacy_agent_write_removed'});
  assert.equal(store.runEvents(run.id).length,1);assert.equal(jobs.get('job-'+previous).attempts,previous==='queued'?0:1);
 }
 assert.equal(reads,0);assert.equal(notified,0);
 const events=f.db.all('SELECT * FROM ops_platform_run_events');
 await store.close();const again=new OperationsPlatformStore(f.deps,jobs);t.after(()=>again.close());
 assert.deepEqual(f.db.all('SELECT * FROM ops_platform_run_events'),events);
 assert.equal(f.db.get<any>('SELECT COUNT(*) n FROM agent_jobs')!.n,3);assert.equal(reads,0);
});
