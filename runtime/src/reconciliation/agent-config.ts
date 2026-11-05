import { NodeStore } from '../server/nodes-model.js';
import { normalizeRemote } from '../agent/config.js';
import { desiredHash } from '../shared/desired-state.js';
import type { Dependencies } from '../shared/types.js';
import type { ReconciliationRegistry } from './registry.js';

export function registerAgentConfiguration(deps: Dependencies, registry: ReconciliationRegistry) {
  const nodes=new NodeStore(deps.db,deps.now);
  registry.register({kind:'agent.config',category:'agent',
    collect:()=>deps.db.all<any>(`SELECT m.id,m.agent_id FROM managed_machines m JOIN agents a ON a.id=m.agent_id WHERE NOT EXISTS(SELECT 1 FROM agent_lifecycle l WHERE l.agent_id=a.id AND l.state='removed')`).map(m=>{
      const compiled=nodes.effective(m.agent_id),config=normalizeRemote(compiled.config);
      return {key:'continuous-tasks',machine_id:m.id,agent_id:m.agent_id,owner_id:m.id,actor:'system',desired:{config},summary:{task_ids:compiled.task_ids,revision:config.revision,host_enabled:config.host_enabled,logs_enabled:config.logs_enabled,probe_count:config.probes.length}};
    }),
    reconcile:r=>{
      const machine=deps.db.get<any>('SELECT agent_id FROM managed_machines WHERE id=?',r.machine_id);
      if(r.deleted)return {state:'blocked',code:'agent_binding_removed'};
      if(machine?.agent_id!==r.agent_id)return {state:'blocked',code:'agent_binding_changed'};
      const agent=deps.db.get<any>('SELECT last_seen,heartbeat FROM agents WHERE id=?',r.agent_id);
      if(!agent||deps.now().getTime()-Date.parse(agent.last_seen)>120000)return {state:'pending',code:'agent_offline'};
      let observation:any;try{observation=JSON.parse(agent.heartbeat).config_observation;}catch{}
      if(!observation||!['runtime_hash','persisted_hash'].every(k=>/^[a-f0-9]{64}$/.test(observation[k]??'')))return {state:'pending',code:'config_observation_required'};
      const expected=desiredHash(r.desired.config);
      if(observation.runtime_hash!==expected||observation.persisted_hash!==expected)return {state:'drifted',code:'agent_configuration_drift'};
      return {state:'in_sync'};
    },
  });
}
