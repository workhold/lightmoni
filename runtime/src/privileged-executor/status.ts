import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { rootPath, refuse } from "./security.js";
import type { ExecutorConfig } from "./config.js";
import { EXECUTOR_JOURNAL_COLUMNS } from "../shared/privileged-executor.js";

/** Read-only lifecycle inspection. Unlike starting a runner this never converts
 * in-flight journal entries or initializes a missing database. */
export function executorStatus(config: ExecutorConfig) {
  const filename = rootPath(join(config.data_dir, "journal.sqlite"), "file", true);
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    if ((db.prepare("PRAGMA integrity_check").get() as any)?.integrity_check !== "ok") refuse("journal_corrupt");
    for(const [name,required] of Object.entries(EXECUTOR_JOURNAL_COLUMNS)){
      if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name))refuse("journal_corrupt");
      const columns=new Set((db.prepare(`PRAGMA table_info(${name})`).all() as {name:string}[]).map(c=>c.name));
      if(required.some(column=>!columns.has(column)))refuse("journal_corrupt");
    }
    if((db.prepare("SELECT value FROM metadata WHERE key='initialized'").get() as any)?.value!=="1"||(db.prepare("SELECT value FROM metadata WHERE key='schema'").get() as any)?.value!=="1")refuse("journal_corrupt");
    const generation = Number((db.prepare("SELECT value FROM metadata WHERE key='policy_generation'").get() as any)?.value);
    if (!Number.isSafeInteger(generation) || generation < 1) refuse("journal_corrupt");
    const rows = db.prepare("SELECT job_id,state FROM jobs WHERE state IN ('prepared','intent','running','unknown') AND NOT EXISTS (SELECT 1 FROM metadata WHERE key='released:'||jobs.job_id)").all();
    const pending = (db.prepare("SELECT COUNT(*) n FROM jobs WHERE state IN ('succeeded','failed','unknown') AND NOT EXISTS (SELECT 1 FROM metadata WHERE key='reported:'||jobs.job_id)").get() as any)?.n;
    return { executor_id: config.executor_id, machine_id: config.machine_id, install_generation: config.install_generation, policy_generation: generation, fenced: rows[0] ?? null, pending_results: pending };
  } finally { db.close(); }
}
