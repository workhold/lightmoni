import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { ExecutorJournal } from "../src/privileged-executor/journal.js";
import { ExecutorClient } from "../src/privileged-executor/client.js";
import { PrivilegedExecutorRunner, type RunnerHost } from "../src/privileged-executor/runner.js";
import { validateConfig, httpsOrigin, parseBootstrap } from "../src/privileged-executor/config.js";
import { canonicalJSON, EXECUTOR_SIGNATURE_HEADER, normalizePrivilegedPayload, signJWS, sha256, verifyJWS, type PrivilegedPlan } from "../src/shared/privileged-executor.js";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "lm-executor-runner-"));
  const center = generateKeyPairSync("ed25519"), executor = generateKeyPairSync("ed25519");
  const publicKey = center.publicKey.export({ type: "spki", format: "pem" }).toString(), account = { name: "root", uid: 0, gid: 0, groups: [] };
  const config = validateConfig({ version: 1, endpoint: "https://center.example.test", center_instance_id: "center", machine_id: "machine", agent_id: "agent", executor_id: "executor", install_generation: 1,
    center_keys: [{ kid: "center-key", public_key: publicKey }], private_key: executor.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), output_key: "b".repeat(64), data_dir: "/var/lib/lightmoni-executor", local_policy: { generation: 1, capabilities: ["script.elevated.v1", "container.managed.v1"] }, accounts: [account], daemon_id: "daemon" });
  let journal = new ExecutorJournal(directory, Buffer.from(config.output_key, "hex"), true); journal.policy(config.local_policy);
  let wall = Date.parse("2026-11-01T01:00:00Z"), mono = 1000;
  const payload = normalizePrivilegedPayload({ kind: "script", runtime: "shell", code: "printf secret", args: [], cwd_profile: "private", environment: {}, account, interpreter_sha256: "a".repeat(64), timeout_ms: 5000, max_output_bytes: 4096 });
  let currentPlan: PrivilegedPlan | undefined, loseClaim = false, loseResult = false, delayPermit = 0, delayStart = 0, runAdvance = 0, runCalls = 0, reports = 0, centerState = "running", releaseFence = false, forgedPermit = false, wrongPolicy = false;
  const requests: { route: string; claims: any; body: any }[] = [];
  const plan = (): PrivilegedPlan => ({ version: 1, purpose: "plan", center_instance_id: "center", machine_id: "machine", agent_id: "agent", executor_id: "executor", install_generation: 1,
    job_id: "job", task_run_id: "job", operation_id: "job", lease_id: "lease_1234567890123456", policy_generation: 1, authorization_id: "grant", authorization_revision: "c".repeat(64), capability: "script.elevated.v1", action: "execute", resource_id: "job", resource_revision: "c".repeat(64), request_sha256: sha256(canonicalJSON(payload)), iat: Math.floor(wall / 1000), nbf: Math.floor(wall / 1000), exp: Math.floor(wall / 1000) + 45, max_runtime_ms: payload.timeout_ms });
  const transport = async (url: string, options: any) => {
    assert.ok(url.startsWith(config.endpoint + "/api/v1/privileged-executors/executor/"));
    const route = url.slice((config.endpoint + "/api/v1/privileged-executors/executor/").length), body = JSON.parse(options.body);
    const claims: any = verifyJWS(options.headers[EXECUTOR_SIGNATURE_HEADER], executor.publicKey, "executor");
    assert.equal(claims.method, "POST"); assert.equal(claims.path, new URL(url).pathname); assert.equal(claims.body_sha256, sha256(options.body)); assert.equal(claims.install_generation, 1);
    requests.push({ route, claims, body });
    if (route === "heartbeat") return { center_instance_id: "center", policy: signJWS({ version: 1, purpose: "policy", center_instance_id: "center", executor_id: "executor", machine_id: wrongPolicy ? "other" : "machine", agent_id: "agent", install_generation: 1, policy_generation: 1, capabilities: config.local_policy.capabilities, iat: Math.floor(wall / 1000), exp: Math.floor(wall / 1000) + 60 }, center.privateKey, "center-key") };
    if (route === "jobs/claim") {
      currentPlan ??= plan();
      if (loseClaim) { loseClaim = false; throw Error("network_lost"); }
      return { job: { plan: signJWS(currentPlan, center.privateKey, "center-key"), payload } };
    }
    if (route === "jobs/job/start-permits") {
      mono += delayPermit;
      return { permit: signJWS({ ...currentPlan, purpose: "start-permit", iat: Math.floor(wall / 1000), nbf: Math.floor(wall / 1000), exp: Math.floor(wall / 1000) + 30, step_id: body.step_id, permit_id: "permit_1234567890123456", executor_nonce: forgedPermit ? "wrong_1234567890123456" : body.executor_nonce }, center.privateKey, "center-key") };
    }
    if (route === "jobs/job/renew") return { lease_expires_at: new Date(wall + 45000).toISOString(), cancel_requested: false };
    if (route === "jobs/job/result") { reports++; centerState = body.state; if (loseResult) { loseResult = false; throw Error("result_reply_lost"); } return { job: { id: "job", state: centerState } }; }
    if (route === "jobs/job/reconcile") return { job: { id: "job", state: centerState }, release_fence: releaseFence };
    throw Error("unexpected_request:" + route);
  };
  const clock = { bootID: () => "boot_12345678901234567890", now: () => mono };
  let client = new ExecutorClient(config, journal, transport, () => wall, clock);
  const host: RunnerHost = { scripts: { interpreter: () => "/trusted/sh", account: () => account, async run(_unit, _interpreter, _payload, signal, guard) { mono += delayStart; guard!.assert(); runCalls++; assert.equal(journal.get("job")?.state, "running"); if (runAdvance) { mono += runAdvance; await new Promise(r => setTimeout(r, 300)); assert.equal(signal.aborted, true); return { state: "failed", code: "cancel_requested", summary: "Proven stopped", exit_code: null, stdout: "", stderr: "" }; } return { state: "succeeded", code: "script_succeeded", summary: "Approved script completed", exit_code: 0, stdout: "sensitive-output", stderr: "" }; } }, docker: { async execute() { throw Error("not_expected"); } },
    async profiles() { return { capabilities: ["script.elevated.v1", "container.managed.v1"], account_profiles: [account], interpreter_profiles: [{ runtime: "shell", sha256: "a".repeat(64) }] }; } };
  const release = { version: "test", release: { build_id: "test", source_revision: "a".repeat(40), artifact_sha256: "b".repeat(64), state_schema: 1 as const } };
  let runner = new PrivilegedExecutorRunner(config, journal, client, release, host, clock);
  return { config, center, payload, requests, plan, get client() { return client; }, get journal() { return journal; }, get runner() { return runner; }, get runCalls() { return runCalls; }, get reports() { return reports; },
    setDelay(ms: number) { delayPermit = ms; }, setStartDelay(ms: number) { delayStart = ms; }, duringRunAdvance(ms: number) { runAdvance = ms; }, loseClaim() { loseClaim = true; }, loseResult() { loseResult = true; }, wrongPermit() { forgedPermit = true; }, wrongPolicy() { wrongPolicy = true; }, advance(ms: number) { wall += ms; mono += ms; },
    restart() { journal.close(); journal = new ExecutorJournal(directory, Buffer.from(config.output_key, "hex")); client = new ExecutorClient(config, journal, transport, () => wall, clock); runner = new PrivilegedExecutorRunner(config, journal, client, release, host, clock); },
    setCenter(state: string, release: boolean) { centerState = state; releaseFence = release; }, close() { journal.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test("root config rejects URL credentials, non-HTTPS, unknown fields and Agent-owned data paths", () => {
  const f = fixture(); try {
    for (const url of ["http://center.test", "https://user:pass@center.test", "https://center.test/subpath", "https://center.test/?q=1", "https://center.test/#x"]) assert.throws(() => httpsOrigin(url));
    assert.throws(() => validateConfig({ ...f.config, data_dir: "/var/lib/lightmoni-agent" })); assert.throws(() => validateConfig({ ...f.config, skip_root: true })); assert.throws(() => parseBootstrap(f.config));
  } finally { f.close(); }
});

test("real Ed25519 plans bind payload, host, identity, generations, policy and full lineage", () => {
  const f = fixture(); try {
    const sign = (p: any) => signJWS(p, f.center.privateKey, "center-key"), valid = f.plan(); assert.equal(f.client.verifyPlan(sign(valid), f.payload).job_id, "job");
    for (const change of [{ machine_id: "other" }, { agent_id: "other" }, { executor_id: "other" }, { center_instance_id: "other" }, { install_generation: 2 }, { policy_generation: 2 }, { task_run_id: "other" }, { operation_id: "other" }, { request_sha256: "0".repeat(64) }, { action: "other" }, { max_runtime_ms: 6000 }, { exp: valid.iat - 1 }]) assert.throws(() => f.client.verifyPlan(sign({ ...valid, ...change }), f.payload));
    assert.throws(() => f.client.verifyPlan(sign(valid), { ...f.payload, code: "changed" }));
    assert.throws(() => f.client.verifyPlan(signJWS(valid, generateKeyPairSync("ed25519").privateKey, "center-key"), f.payload));
  } finally { f.close(); }
});

test("script runs once only after durable intent and an online permit then reports bounded private output", async () => {
  const f = fixture(); try { await f.runner.once(); assert.equal(f.runCalls, 1); assert.equal(f.journal.get("job")?.state, "succeeded"); assert.equal(f.journal.reported("job"), true); assert.equal(f.reports, 1); await f.runner.once(); assert.equal(f.runCalls, 1); assert.equal(f.reports, 1); assert.equal(f.journal.get("job")?.result.stdout, "sensitive-output"); }
  finally { f.close(); }
});

test("lost claim response retains its request ID across fresh signing and never runs twice", async () => {
  const f = fixture(); try { f.loseClaim(); await assert.rejects(f.runner.once(), /network_lost/); assert.equal(f.runCalls, 0); f.advance(1000); await f.runner.once(); assert.equal(f.runCalls, 1); const claims = f.requests.filter(r => r.route === "jobs/claim"); assert.equal(claims[0].claims.request_id, claims[1].claims.request_id); assert.notEqual(claims[0].claims.iat, claims[1].claims.iat); }
  finally { f.close(); }
});

test("an expired cached claim is persisted as zero execution and its request slot can finish safely", async () => {
  const f = fixture(); try {
    f.loseClaim(); await assert.rejects(f.runner.once(), /network_lost/); f.advance(46_000);
    await f.runner.once(); assert.equal(f.runCalls, 0); assert.equal(f.journal.get("job")?.result.code, "expired_plan"); assert.equal(f.journal.hasRequest("claim"), false);
  } finally { f.close(); }
});

test("a lost result reply reconciles the existing result without running the approved script again", async () => {
  const f = fixture(); try {
    f.loseResult(); await f.runner.once(); assert.equal(f.runCalls, 1); assert.equal(f.reports, 1); assert.equal(f.journal.reported("job"), true);
    assert.equal(f.requests.some(r => r.route === "jobs/job/reconcile"), true); await f.runner.once(); assert.equal(f.runCalls, 1); assert.equal(f.reports, 1);
  } finally { f.close(); }
});

test("a permit expiring after journal intent but before the final host start is refused and remains fenced", async () => {
  const f = fixture(); try {
    f.setStartDelay(30_001); await f.runner.once(); assert.equal(f.runCalls, 0); assert.equal(f.journal.get("job")?.state, "unknown"); assert.equal(f.journal.fenced()?.job_id, "job");
  } finally { f.close(); }
});

test("a proven runtime timeout remains failed while an expired execution lease remains unknown and fenced", async t => {
  for (const [elapsed, state, code] of [[6000, "failed", "timeout"], [46_000, "unknown", "lease_lost"]] as const) await t.test(code, async () => {
    const f = fixture(); try { f.duringRunAdvance(elapsed); await f.runner.once(); assert.equal(f.runCalls, 1); assert.equal(f.journal.get("job")?.state, state); assert.equal(f.journal.get("job")?.result.code, code); assert.equal(!!f.journal.fenced(), state === "unknown"); } finally { f.close(); }
  });
});

test("signed policy revisions persist monotonically and cannot roll back or change capabilities at the same generation", () => {
  const f = fixture(); try {
    const base = { version: 1, purpose: "policy", center_instance_id: "center", executor_id: "executor", machine_id: "machine", agent_id: "agent", install_generation: 1, policy_generation: 2, capabilities: [], iat: Date.parse("2026-11-01T01:00:00Z") / 1000, exp: Date.parse("2026-11-01T01:00:30Z") / 1000 };
    f.client.applyPolicy(signJWS(base, f.center.privateKey, "center-key")); assert.equal(f.journal.policy().generation, 2);
    assert.throws(() => f.client.applyPolicy(signJWS({ ...base, policy_generation: 1 }, f.center.privateKey, "center-key")), /stale_policy/);
    assert.throws(() => f.client.applyPolicy(signJWS({ ...base, capabilities: ["script.elevated.v1"] }, f.center.privateKey, "center-key")), /policy_revision_conflict/);
    f.restart(); assert.deepEqual(f.journal.policy(), { generation: 2, capabilities: [] });
  } finally { f.close(); }
});

test("late and wrong-nonce permits produce zero script execution", async t => {
  for (const mode of ["delayed", "wrong-nonce"]) await t.test(mode, async () => { const f = fixture(); try { if (mode === "delayed") f.setDelay(30001); else f.wrongPermit(); await f.runner.once(); assert.equal(f.runCalls, 0); assert.equal(f.journal.get("job")?.state, "failed"); assert.equal(f.journal.fenced(), undefined); } finally { f.close(); } });
});

test("journal intent failure refuses execution instead of swallowing persistence errors", async () => {
  const f = fixture(); try { f.journal.intent = () => { throw Error("disk_full"); }; await f.runner.once(); assert.equal(f.runCalls, 0); assert.equal(f.journal.get("job")?.state, "failed"); } finally { f.close(); }
});

test("restart keeps an in-flight job unknown and fenced until explicit center reconciliation", async () => {
  const f = fixture(); try {
    const p = f.plan(); f.journal.prepare(p.job_id, p.request_sha256, p.authorization_id, p.lease_id, p, f.payload); f.journal.nonce("job", "e".repeat(64)); f.journal.intent("job", "permit_1234567890123456", "e".repeat(64), "lightmoni-exec-" + "d".repeat(32)); f.journal.running("job");
    f.restart(); await f.runner.once(); assert.equal(f.runCalls, 0); assert.equal(f.journal.fenced()?.state, "unknown"); f.setCenter("unknown", true); await f.runner.once(); assert.equal(f.runCalls, 0); assert.equal(f.journal.fenced(), undefined);
  } finally { f.close(); }
});

test("a validly signed policy for another host refuses before claim", async () => {
  const f = fixture(); try { f.wrongPolicy(); await assert.rejects(f.runner.once(), /principal_mismatch/); assert.equal(f.requests.some(r => r.route === "jobs/claim"), false); assert.equal(f.runCalls, 0); } finally { f.close(); }
});
