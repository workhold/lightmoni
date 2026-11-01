import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { join } from "node:path";
import { refuse, sha256 } from "./security.js";
import { canonicalJSON } from "../shared/privileged-executor.js";

export type JournalState = "prepared" | "intent" | "running" | "succeeded" | "failed" | "unknown";
export interface JournalJob {
  job_id: string; digest: string; grant_id: string; lease_id: string; state: JournalState;
  plan: any; payload: any; unit: string; nonce: string; permit_id: string; result: any;
}
const ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** Storage primitive shared by production composition and isolated fixtures.
 * Production validates actual UID and root-owned paths before opening it. */
export class ExecutorJournal {
  private readonly db: DatabaseSync;
  constructor(readonly directory: string, private readonly outputKey: Buffer, initialize = false) {
    if (outputKey.length !== 32) refuse("invalid_output_key");
    const filename = join(directory, "journal.sqlite");
    if (!initialize && !fs.existsSync(filename)) refuse("journal_missing_requires_recovery");
    const existed = fs.existsSync(filename);
    if (existed && (!fs.lstatSync(filename).isFile() || fs.lstatSync(filename).isSymbolicLink())) refuse("unsafe_journal");
    if (!existed && initialize) { const fd = fs.openSync(filename, "wx", 0o600); fs.closeSync(fd); }
    this.db = new DatabaseSync(filename);
    try {
      this.db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
      if (initialize) this.db.exec(`CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS jobs(job_id TEXT PRIMARY KEY,digest TEXT NOT NULL,grant_id TEXT NOT NULL,lease_id TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('prepared','intent','running','succeeded','failed','unknown')),
          plan_json TEXT NOT NULL,payload_json TEXT NOT NULL,unit TEXT NOT NULL DEFAULT '',nonce TEXT NOT NULL DEFAULT '',permit_id TEXT NOT NULL DEFAULT '',result_json TEXT NOT NULL DEFAULT '{}');
        CREATE TABLE IF NOT EXISTS consumed_grants(grant_id TEXT PRIMARY KEY,job_id TEXT NOT NULL UNIQUE,digest TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS requests(slot TEXT PRIMARY KEY,id TEXT NOT NULL,digest TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS resources(resource_id TEXT PRIMARY KEY,value_json TEXT NOT NULL);`);
      const check = this.db.prepare("PRAGMA integrity_check").get() as any;
      if (check?.integrity_check !== "ok") refuse("journal_corrupt");
      if (initialize) { this.db.prepare("INSERT OR IGNORE INTO metadata(key,value) VALUES('initialized','1')").run(); this.db.prepare("INSERT OR IGNORE INTO metadata(key,value) VALUES('schema','1')").run(); }
      if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='metadata'").get()) refuse("journal_missing_requires_recovery");
      if ((this.db.prepare("SELECT value FROM metadata WHERE key='initialized'").get() as any)?.value !== "1" || (this.db.prepare("SELECT value FROM metadata WHERE key='schema'").get() as any)?.value !== "1") refuse("journal_missing_requires_recovery");
      for (const table of ["metadata", "jobs", "consumed_grants", "requests", "resources"]) if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) refuse("journal_corrupt");
      this.db.prepare("UPDATE jobs SET state='unknown',result_json=? WHERE state IN ('intent','running')").run(JSON.stringify({ state: "unknown", code: "executor_restarted", summary: "Execution outcome requires read-only reconciliation", exit_code: null, stdout: "", stderr: "" }));
      // Prepared work has no side effect and may only be resumed after obtaining
      // a new online lease/permit. A previous boot's nonce is never reusable.
      this.db.prepare("UPDATE jobs SET nonce='',permit_id='' WHERE state='prepared'").run();
    } catch (error) { this.db.close(); throw error; }
  }
  close() { this.db.close(); }
  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  private decode(row: any): JournalJob {
    return { ...row, plan: JSON.parse(row.plan_json), payload: JSON.parse(row.payload_json), result: this.decryptResult(JSON.parse(row.result_json)), plan_json: undefined, payload_json: undefined, result_json: undefined };
  }
  get(jobID: string): JournalJob | undefined {
    const row = this.db.prepare("SELECT * FROM jobs WHERE job_id=?").get(jobID);
    return row ? this.decode(row) : undefined;
  }
  all(): JournalJob[] { return this.db.prepare("SELECT * FROM jobs ORDER BY rowid").all().map(row => this.decode(row)); }
  fenced(): JournalJob | undefined { return this.all().find(row => ["intent", "running", "unknown"].includes(row.state) && !this.released(row.job_id)); }
  private released(jobID: string): boolean { return !!this.db.prepare("SELECT 1 FROM metadata WHERE key=?").get("released:" + jobID); }
  releaseFence(jobID: string): void {
    const row = this.get(jobID);
    if (!row || row.state !== "unknown") refuse("journal_state_conflict");
    this.db.prepare("INSERT OR REPLACE INTO metadata(key,value) VALUES(?,'1')").run("released:" + jobID);
  }
  prepare(jobID: string, digest: string, grantID: string, leaseID: string, plan: any, payload: any): JournalJob {
    if (![jobID, grantID, leaseID].every(value => ID.test(value)) || !/^[a-f0-9]{64}$/.test(digest) || sha256(canonicalJSON(payload)) !== digest) refuse("invalid_job");
    return this.tx(() => {
      const previous = this.get(jobID);
      if (previous) { if (previous.digest !== digest || previous.grant_id !== grantID) refuse("replay_conflict"); return previous; }
      if (this.fenced()) refuse("execution_unknown");
      if (this.db.prepare("SELECT 1 FROM consumed_grants WHERE grant_id=?").get(grantID)) refuse("grant_consumed");
      this.db.prepare("INSERT INTO jobs(job_id,digest,grant_id,lease_id,state,plan_json,payload_json) VALUES(?,?,?,?,'prepared',?,?)").run(jobID, digest, grantID, leaseID, JSON.stringify(plan), JSON.stringify(payload));
      return this.get(jobID)!;
    });
  }
  nonce(jobID: string, nonce: string): void {
    if (!/^[a-f0-9]{64}$/.test(nonce)) refuse("invalid_nonce");
    const changed = this.db.prepare("UPDATE jobs SET nonce=?,permit_id='' WHERE job_id=? AND state='prepared'").run(nonce, jobID);
    if (!changed.changes) refuse("journal_state_conflict");
  }
  intent(jobID: string, permitID: string, nonce: string, unit: string): void {
    if (!ID.test(permitID) || !/^lightmoni-exec-[a-f0-9]{32}$/.test(unit)) refuse("invalid_intent");
    this.tx(() => {
      const row = this.get(jobID) ?? refuse("journal_state_conflict");
      if (row.state !== "prepared" || row.nonce !== nonce || this.fenced()) refuse("journal_state_conflict");
      this.db.prepare("INSERT INTO consumed_grants(grant_id,job_id,digest) VALUES(?,?,?)").run(row.grant_id, row.job_id, row.digest);
      this.db.prepare("UPDATE jobs SET state='intent',permit_id=?,unit=? WHERE job_id=? AND state='prepared'").run(permitID, unit, jobID);
    });
  }
  running(jobID: string): void {
    if (!this.db.prepare("UPDATE jobs SET state='running' WHERE job_id=? AND state='intent'").run(jobID).changes) refuse("journal_state_conflict");
  }
  finish(jobID: string, state: "succeeded" | "failed" | "unknown", result: any): void {
    const row = this.get(jobID);
    if (!row || row.state === "unknown" && state !== "unknown" || ["succeeded", "failed"].includes(row.state)) refuse("journal_state_conflict");
    this.db.prepare("UPDATE jobs SET state=?,result_json=? WHERE job_id=?").run(state, JSON.stringify(this.encryptResult(result)), jobID);
  }
  acknowledge(jobID: string): void { this.db.prepare("INSERT OR REPLACE INTO metadata(key,value) VALUES(?, '1')").run("reported:" + jobID); }
  reported(jobID: string): boolean { return !!this.db.prepare("SELECT 1 FROM metadata WHERE key=?").get("reported:" + jobID); }
  policyGeneration(value?: number): number {
    return this.tx(() => {
    const current = Number((this.db.prepare("SELECT value FROM metadata WHERE key='policy_generation'").get() as any)?.value ?? 0);
    if (!Number.isSafeInteger(current) || current < 0) refuse("journal_corrupt");
    if (value !== undefined) {
      if (!Number.isSafeInteger(value) || value < current) refuse("stale_policy");
      this.db.prepare("INSERT OR REPLACE INTO metadata(key,value) VALUES('policy_generation',?)").run(String(value));
      return value;
    }
    return current;
    });
  }
  policy(value?: { generation: number; capabilities: readonly string[] }): { generation: number; capabilities: string[] } {
    return this.tx(() => {
      const row = this.db.prepare("SELECT value FROM metadata WHERE key='policy'").get() as any;
      const current = row ? JSON.parse(row.value) : { generation: 0, capabilities: [] };
      const highest = Number((this.db.prepare("SELECT value FROM metadata WHERE key='policy_generation'").get() as any)?.value ?? 0);
      if (!Number.isSafeInteger(highest) || highest < 0 || !Number.isSafeInteger(current.generation) || current.generation < 0 || !Array.isArray(current.capabilities)) refuse("journal_corrupt");
      if (value) {
        if (!Number.isSafeInteger(value.generation) || value.generation < Math.max(current.generation, highest)) refuse("stale_policy");
        if (value.generation === current.generation && canonicalJSON([...value.capabilities].sort()) !== canonicalJSON([...current.capabilities].sort())) refuse("policy_revision_conflict");
        const next = { generation: value.generation, capabilities: [...value.capabilities].sort() };
        this.db.prepare("INSERT OR REPLACE INTO metadata(key,value) VALUES('policy',?)").run(canonicalJSON(next));
        this.db.prepare("INSERT OR REPLACE INTO metadata(key,value) VALUES('policy_generation',?)").run(String(next.generation));
        return next;
      }
      if (current.generation < highest) refuse("stale_policy");
      return current;
    });
  }
  request(slot: string, digest: string): string {
    return this.tx(() => {
      const previous = this.db.prepare("SELECT * FROM requests WHERE slot=?").get(slot) as any;
      if (previous) { if (previous.digest !== digest) refuse("request_replay_conflict"); return previous.id; }
      const id = randomBytes(16).toString("hex");
      this.db.prepare("INSERT INTO requests(slot,id,digest) VALUES(?,?,?)").run(slot, id, digest); return id;
    });
  }
  clearRequest(slot: string) { this.db.prepare("DELETE FROM requests WHERE slot=?").run(slot); }
  hasRequest(slot: string): boolean { return !!this.db.prepare("SELECT 1 FROM requests WHERE slot=?").get(slot); }
  resources(): any[] { return this.db.prepare("SELECT value_json FROM resources ORDER BY resource_id").all().map((row: any) => JSON.parse(row.value_json)); }
  setResources(resources: readonly any[]): void {
    this.tx(() => { this.db.exec("DELETE FROM resources"); for (const value of resources) this.db.prepare("INSERT INTO resources(resource_id,value_json) VALUES(?,?)").run(value.resource_id, JSON.stringify(value)); });
  }
  private encryptResult(result: any) {
    const { stdout = "", stderr = "", ...metadata } = result;
    if (typeof stdout !== "string" || typeof stderr !== "string" || Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > 256 << 10) refuse("output_limit");
    const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", this.outputKey, nonce);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ stdout, stderr })), cipher.final()]);
    return { ...metadata, sensitive_output: Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString("base64") };
  }
  private decryptResult(result: any) {
    if (!result.sensitive_output) return result;
    const raw = Buffer.from(result.sensitive_output, "base64"), decipher = createDecipheriv("aes-256-gcm", this.outputKey, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const output = JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8"));
    const { sensitive_output, ...metadata } = result; return { ...metadata, ...output };
  }
}
