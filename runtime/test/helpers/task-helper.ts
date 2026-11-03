import type { Dependencies } from "../../src/shared/types.js";
import type { TaskRunStore } from "../../src/server/task-center.js";
import { SCRIPT_TASK_CAPABILITIES } from "../../src/shared/task-center.js";

/** Unit-test double for the signature-verified helper adapter. Authentication is
 * exercised separately by privileged-executors.test.ts and the HTTP tests. */
export function taskHelperFixture(deps: Dependencies, runs: TaskRunStore) {
  const db = deps.db;
  db.exec(`CREATE TABLE IF NOT EXISTS machine_agent_runtime(
    machine_id TEXT PRIMARY KEY,agent_id TEXT NOT NULL,runtime_mode TEXT NOT NULL,
    permission_generation INTEGER NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS privileged_executors(
    id TEXT PRIMARY KEY,machine_id TEXT NOT NULL,agent_id TEXT NOT NULL,
    install_generation INTEGER NOT NULL,state TEXT NOT NULL);`);
  const provision = () => {
    for (const host of db.all<{ id: string; agent_id: string }>("SELECT id,agent_id FROM managed_machines WHERE agent_id!=''")) {
      db.run("INSERT OR IGNORE INTO machine_agent_runtime VALUES(?,?,'root',3,?)", host.id, host.agent_id, deps.now().toISOString());
      db.run("INSERT OR IGNORE INTO privileged_executors VALUES(?,?,?,1,'active')", "helper-" + host.id, host.id, host.agent_id);
    }
  };
  const attach = (store: TaskRunStore) => {
    store.ordinaryTaskIdentity = (machineID, agentID, executorID, installGeneration) => {
      const runtime = db.get<any>("SELECT * FROM machine_agent_runtime WHERE machine_id=? AND agent_id=? AND runtime_mode='root'", machineID, agentID);
      const executor = db.get("SELECT id FROM privileged_executors WHERE id=? AND machine_id=? AND agent_id=? AND install_generation=? AND state='active'", executorID, machineID, agentID, installGeneration);
      return runtime && executor ? { account: "lightmoni-agent", uid: 1001, gid: 1001, permission_generation: runtime.permission_generation } : null;
    };
    store.nodes.taskScriptCapabilities = (machineID, agentID) => {
      const executor = db.get<any>("SELECT id,install_generation FROM privileged_executors WHERE machine_id=? AND agent_id=? AND state='active' ORDER BY install_generation DESC LIMIT 1", machineID, agentID);
      return executor && store.ordinaryTaskIdentity?.(machineID, agentID, executor.id, executor.install_generation) ? [...SCRIPT_TASK_CAPABILITIES] : [];
    };
    return store;
  };
  const helper = (agentID: string) => {
    const machine = db.get<{ id: string }>("SELECT id FROM managed_machines WHERE agent_id=?", agentID);
    const executor = machine && db.get<any>("SELECT id,install_generation FROM privileged_executors WHERE machine_id=? AND agent_id=? AND state='active'", machine.id, agentID);
    if (!machine || !executor) throw Error("test_helper_unavailable");
    return { id: executor.id as string, machine_id: machine.id, agent_id: agentID, install_generation: executor.install_generation as number };
  };
  provision();
  attach(runs);
  return {
    provision, attach, helper,
    claim: (agentID: string, capabilities: string[]) => runs.claimForHelper(helper(agentID), { capabilities }).run,
    result: (agentID: string, id: string, input: any) => runs.resultForHelper(helper(agentID), id, input),
  };
}
