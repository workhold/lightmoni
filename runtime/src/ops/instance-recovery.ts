import { operationExecutionCapabilities } from "../server/managed-executor-status.js";
import { hash } from "../operations/website-files.js";
import { fail } from "../shared/http.js";
import { hasActiveTaskRuns } from "../server/agent-hosts.js";
import type { PlatformStore, PlatformRun } from "./types.js";
type Row = Record<string, any>;
const active = [
  "queued",
  "leased",
  "accepted",
  "preflighting",
  "staging",
  "activating",
  "verifying",
  "running",
  "unknown",
];
export const INSTANCE_RECOVERY_CAPABILITY =
  "operations.platform.instance-recovery.v1";
export function createInstanceRecoverySchema(store: PlatformStore) {
  store.deps.db.exec(
    `CREATE TABLE IF NOT EXISTS ops_instance_recoveries(instance_id TEXT PRIMARY KEY,run_id TEXT NOT NULL,snapshot_json TEXT NOT NULL,status TEXT NOT NULL,updated_at TEXT NOT NULL);`,
  );
}
function online(store: PlatformStore, id: string) {
  const a = store.deps.db.get<Row>(
    "SELECT * FROM agents WHERE id=? AND NOT EXISTS (SELECT 1 FROM agent_lifecycle l WHERE l.agent_id=agents.id AND l.state='removed')",
    id,
  );
  return !!a && store.deps.now().getTime() - Date.parse(a.last_seen) < 120000;
}
function snapshot(store: PlatformStore, i: Row) {
  const m = store.deps.db.get<Row>(
    "SELECT * FROM managed_machines WHERE id=?",
    i.machine_id,
  );
  if (!m) return;
  return {
    instance_id: i.id,
    owner_id: i.owner_id,
    machine_id: i.machine_id,
    old_agent_id: i.agent_id,
    current_agent_id: m.agent_id,
    current_run_id: i.current_run_id,
    desired_generation: i.desired_generation,
    desired_state: i.desired_state,
    state: i.state,
    retired: i.retired,
    target: hash(
      JSON.stringify([
        m.address,
        m.port,
        m.username,
        m.ssh_target_generation,
        m.host_key_fingerprint,
      ]),
    ),
  };
}
function unresolved(store: PlatformStore, i: Row) {
  return (
    i.state === "unknown" ||
    !!store.deps.db.get(
      "SELECT id FROM ops_platform_runs WHERE agent_id=? AND state IN (" +
        active.map(() => "?").join(",") +
        ") LIMIT 1",
      i.agent_id,
      ...active,
    ) ||
    !!store.deps.db.get(
      "SELECT id FROM agent_jobs WHERE agent_id=? AND state NOT IN ('succeeded','failed','cancelled') LIMIT 1",
      i.agent_id,
    ) ||
    hasActiveTaskRuns(store.deps.db, i.agent_id)
  );
}
function dataReviewRequired(store: PlatformStore, i: Row) {
  const specs = [
    store.get(i.owner_id).spec,
    ...store.deps.db
      .all<Row>(
        "SELECT spec_cipher FROM ops_platform_revisions WHERE resource_id=? AND revision IN (?,?)",
        i.owner_id,
        Number(i.observed_generation) || 0,
        Number(i.desired_generation) || 0,
      )
      .map((r) => JSON.parse(store.deps.decrypt(r.spec_cipher))),
  ];
  return specs.some(
    (s) =>
      s.stateful === true ||
      s.mounts?.some((m: Row) => ["data", "volume", "init"].includes(m.type)) ||
      Object.values<Row>(s.compose?.services ?? {}).some(
        (service) => service.volumes?.length,
      ),
  );
}
export function validateInstanceRecoveryPayload(
  store: PlatformStore,
  config: Row,
  agentID: string,
) {
  if (config.task !== "instance.recovery.inspect") return;
  const i = store.deps.db.get<Row>(
    "SELECT * FROM ops_cluster_instances WHERE id=?",
    config.instance_id,
  );
  const current = i && snapshot(store, i);
  if (
    !i ||
    !current ||
    current.current_agent_id !== agentID ||
    current.old_agent_id === agentID ||
    JSON.stringify(current) !== JSON.stringify(config.recovery) ||
    online(store, i.agent_id) ||
    unresolved(store, i)
  )
    fail(409, "instance_recovery_target_changed");
}
/** Only the current authenticated Agent can attest absence on its stable machine binding. */
export function recoverReinstalledInstances(
  store: PlatformStore,
  machineIDs: string[],
  actor: string,
) {
  const { db } = store.deps,
    runs: PlatformRun[] = [],
    blockedMachines = new Set<string>();
  let pending = "";
  for (const machineID of machineIDs) {
    const m = db.get<Row>(
      "SELECT * FROM managed_machines WHERE id=?",
      machineID,
    );
    if (!m?.agent_id || !online(store, m.agent_id)) continue;
    const old = db.all<Row>(
      "SELECT * FROM ops_cluster_instances WHERE machine_id=? AND agent_id!=? AND (retired=0 OR state NOT IN ('stopped','removed')) ORDER BY created_at,id",
      machineID,
      m.agent_id,
    );
    if (old.length) blockedMachines.add(machineID);
    for (const i of old) {
      if (dataReviewRequired(store, i)) {
        pending = "agent_reinstall_stateful_review_required";
        continue;
      }
      if (online(store, i.agent_id) || unresolved(store, i)) {
        pending = "agent_reinstall_execution_unresolved";
        continue;
      }
      const caps=operationExecutionCapabilities(store.deps,m.agent_id);
      if (
        !Array.isArray(caps) ||
        !caps.includes(INSTANCE_RECOVERY_CAPABILITY)
      ) {
        pending = "agent_reinstall_upgrade_required";
        continue;
      }
      const previous = db.get<Row>(
          "SELECT * FROM ops_instance_recoveries WHERE instance_id=?",
          i.id,
        ),
        target = snapshot(store, i)!;
      const run =
        previous &&
        db.get<Row>(
          "SELECT state FROM ops_platform_runs WHERE id=?",
          previous.run_id,
        );
      if (previous && previous.snapshot_json === JSON.stringify(target)) {
        if (run && active.includes(run.state) && run.state !== "unknown") {
          pending = "agent_reinstall_inspecting";
          continue;
        }
        if (
          store.deps.now().getTime() - Date.parse(previous.updated_at) <
          30000
        ) {
          pending = previous.status;
          continue;
        }
      }
      const owner = store.get(i.owner_id),
        by = store.authorized(owner.authorized_by)
          ? owner.authorized_by
          : actor;
      const queued = store.queue(
        owner,
        m.agent_id,
        "inspect",
        {
          task: "instance.recovery.inspect",
          instance_id: i.id,
          cluster_id: i.cluster_id,
          recovery: target,
        },
        by,
      );
      db.run(
        "INSERT INTO ops_instance_recoveries VALUES(?,?,?,?,?) ON CONFLICT(instance_id) DO UPDATE SET run_id=excluded.run_id,snapshot_json=excluded.snapshot_json,status=excluded.status,updated_at=excluded.updated_at",
        i.id,
        queued.id,
        JSON.stringify(target),
        "agent_reinstall_inspecting",
        store.deps.now().toISOString(),
      );
      runs.push(queued);
      pending = "agent_reinstall_inspecting";
    }
  }
  return { runs, pending, blockedMachines };
}
export function recordInstanceRecovery(
  store: PlatformStore,
  run: PlatformRun,
  config: Row,
) {
  if (config.task !== "instance.recovery.inspect") return false;
  if (!["succeeded", "failed", "unknown", "cancelled"].includes(run.state))
    return true;
  const { db } = store.deps,
    at = store.deps.now().toISOString();
  // AgentJob result notifications execute inside the existing receipt transaction.
  const previous = db.get<Row>(
    "SELECT * FROM ops_instance_recoveries WHERE instance_id=? AND run_id=?",
    config.instance_id,
    run.id,
  );
  if (!previous) return true;
  let status = "agent_reinstall_inspection_failed",
    valid = false;
  const result = run.result;
  try {
    validateInstanceRecoveryPayload(store, config, run.agent_id);
    valid =
      run.state === "succeeded" &&
      result.instance_id === config.instance_id &&
      Number.isSafeInteger(result.container_count) &&
      result.container_count >= 0 &&
      result.container_count <= 300 &&
      result.absent === (result.container_count === 0) &&
      Date.parse(result.observed_at) >= Date.parse(run.created_at) &&
      Date.parse(result.observed_at) <= store.deps.now().getTime() + 30000;
  } catch {
    /* A stale binding or unresolved old execution cannot release reservations. */
  }
  if (valid) {
    status = "agent_reinstall_containers_remain";
    if (result.absent) {
      const i = db.get<Row>(
        "SELECT * FROM ops_cluster_instances WHERE id=?",
        config.instance_id,
      )!;
      const observed = JSON.parse(i.observed_json);
      observed.agent_recovery = {
        run_id: run.id,
        previous_agent_id: i.agent_id,
        current_agent_id: run.agent_id,
        verified_at: at,
        container_count: 0,
        scope: "current_machine_binding",
      };
      // Do not catch storage errors: the outer receipt transaction must roll back every mutation.
      db.run(
        "UPDATE ops_cluster_instances SET retired=1,state='stopped',desired_state='stopped',healthy=0,current_run_id='',observed_json=?,updated_at=? WHERE id=?",
        JSON.stringify(observed),
        at,
        i.id,
      );
      db.run("DELETE FROM ops_platform_ports WHERE instance_id=?", i.id);
      status = "completed";
    }
  }
  db.run(
    "UPDATE ops_instance_recoveries SET status=?,updated_at=? WHERE instance_id=? AND run_id=?",
    status,
    at,
    config.instance_id,
    run.id,
  );
  return true;
}
