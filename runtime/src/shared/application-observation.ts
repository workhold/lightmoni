import type { DB } from './sqlite.js';
import { fail } from './http.js';

export const APPLICATION_TABLE = 'lightmoni_application';
export const APPLICATION_METRICS = 'metric_lightmoni_application_gauge';
export const APPLICATION_LOGS = 'log_lightmoni_application';
export interface ApplicationTarget {
  deployment_id: string; application_id: string; cluster_id: string;
  machine_id: string; service_name: string; role: string;
}
export interface DockerContainer {
  id: string; name: string; image: string; state: string; ports: string;
  deployment_id: string;
}
export interface DockerInventory {
  compose_available?: boolean;
  observed_at: string; state: 'ready' | 'unavailable'; error?: string;
  attempted_at?: string;
  truncated: boolean; containers: DockerContainer[];
}
const has = (db: DB, name: string) => !!db.get("SELECT name FROM sqlite_master WHERE type='table' AND name=?", name);
export function applicationTargets(db: DB, agentID: string, decrypt?: (value:string)=>string): ApplicationTarget[] {
  if (!has(db, 'ops_cluster_instances')) return [];
  // IDs are assigned by the control plane, never chosen from container labels.
  return db.all<any>('SELECT i.id deployment_id,i.owner_id application_id,i.cluster_id,i.machine_id,r.spec_cipher FROM ops_cluster_instances i JOIN ops_platform_resources r ON r.id=i.owner_id WHERE i.agent_id=? AND r.kind=\'application\' ORDER BY i.id LIMIT 1000', agentID).map(({spec_cipher,...i}) => {let spec:any={};try{if(decrypt)spec=JSON.parse(decrypt(spec_cipher));}catch{}return {...i,service_name:spec.service_name??'',role:spec.role??''};});
}
const text = (v: unknown, max = 256) => typeof v === 'string' ? v.replace(/[\x00-\x1f\x7f]/g, '').slice(0, max) : '';
export function dockerInventory(value: any): DockerInventory | undefined {
  if (value === undefined) return undefined;
  if (!value || !Array.isArray(value.containers) || value.containers.length > 500 || !['ready','unavailable'].includes(value.state) || !Number.isFinite(Date.parse(value.observed_at))) fail(400, 'invalid_docker_inventory');
  const errors=['docker_cli_missing','docker_permission_denied','docker_daemon_unavailable','docker_command_timeout','docker_collection_unavailable'];
  return {observed_at: new Date(value.observed_at).toISOString(), state: value.state, ...(typeof value.compose_available==='boolean'?{compose_available:value.compose_available}:{}), truncated: value.truncated === true,
    ...(Number.isFinite(Date.parse(value.attempted_at))?{attempted_at:new Date(value.attempted_at).toISOString()}:{}),
    ...(value.state === 'unavailable' ? {error: errors.includes(value.error)?value.error:'docker_collection_unavailable'} : {}),
    containers: value.containers.map((c: any) => {
      if (!/^[a-f0-9]{12,64}$/.test(c?.id)) fail(400, 'invalid_docker_container');
      return {id: c.id, name: text(c.name), image: text(c.image), state: text(c.state,32), ports: text(c.ports,1024), deployment_id: text(c.deployment_id,128)};
    })};
}
export function bindApplicationRows(db: DB, agentID: string, rows: any[], decrypt?: (value:string)=>string) {
  const targets = new Map(applicationTargets(db, agentID, decrypt).map(t => [t.deployment_id, t]));
  for (const n of rows) {
    const a = n.row.attributes, target = targets.get(a.deployment_id);
    if (!target || !/^[a-f0-9]{12,64}$/.test(a.container_id ?? '') || !(n.kind === 'log' || (n.kind === 'metric' && n.subtype === 'gauge'))) fail(403, 'application_observation_ownership_required');
    if(a.website_id){let site:any;try{const stored=db.get<any>("SELECT spec_cipher FROM ops_platform_resources WHERE id=? AND kind='website'",a.website_id);if(stored&&decrypt)site=JSON.parse(decrypt(stored.spec_cipher));}catch{}if(target.role!=='openresty'||!site?.cluster_ids?.includes(target.cluster_id))fail(403,'website_observation_ownership_required');}
    Object.assign(a, {application_id: target.application_id, cluster_id: target.cluster_id, machine_id: target.machine_id, 'lightmoni.component':'application'});
    n.row.agent_id = agentID;
    n.row.host_id = db.get<any>('SELECT host_id FROM agents WHERE id=?', agentID)?.host_id ?? '';
    n.row.service = target.service_name || target.application_id;
    n.row.attributes_json = JSON.stringify(a);
  }
}
