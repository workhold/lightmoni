import type { DB } from '../shared/sqlite.js';
import { dockerObservation } from '../ops/docker.js';
export interface DockerEnvironment { state:string; code:string; observed_at:string }
export function machineDockerEnvironment(db:DB,agentID:string,now:Date):DockerEnvironment {
  const unknown={state:'unknown',code:'',observed_at:''};
  if(!agentID)return unknown;
  try {
    const agent=db.get<any>('SELECT * FROM agents WHERE id=?',agentID);
    if(!agent)return unknown;
    const {snapshot}=dockerObservation(db,agentID,JSON.parse(agent.heartbeat||'{}'));
    if(!snapshot)return unknown;
    const observed=snapshot.attempted_at||snapshot.observed_at;
    const recent=Number.isFinite(Date.parse(observed))&&now.getTime()-Date.parse(observed)<=120000&&Date.parse(observed)<=now.getTime()+60000;
    const online=Number.isFinite(Date.parse(agent.last_seen))&&now.getTime()-Date.parse(agent.last_seen)<=120000;
    if(!recent||!online)return {state:'stale',code:snapshot.error??'',observed_at:observed};
    const state=snapshot.state==='ready'?(snapshot.compose_available===false?'compose_missing':'ready'):
      ({docker_cli_missing:'missing',docker_daemon_unavailable:'daemon_unavailable',docker_permission_denied:'permission_denied'} as Record<string,string>)[snapshot.error??'']??'unavailable';
    return {state,code:state==='compose_missing'?'compose_unavailable':snapshot.error??'',observed_at:observed};
  } catch {return unknown;}
}
