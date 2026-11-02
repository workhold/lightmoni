import {prepareApplicationYAML,stripComposeExtensions} from './application-yaml.js';
import {publicWebsiteSpec} from './website-auth.js';
import {registryCacheFor} from './registry-runtime.js';
import {createClusterWorkloads} from './cluster-workloads.js';
import {fail} from '../shared/http.js';
import type {DomainController,PlatformOptions} from './types.js';

const sanitizeEnvironment = (spec: any) => {
  const out = structuredClone(spec);
  if(out.compose&&typeof out.compose==='object')stripComposeExtensions(out.compose);
  if (out.environment)
    out.environment = Object.fromEntries(
      Object.keys(out.environment).map((k) => [k, "[redacted]"]),
    );
  if (out.compose?.services)
    for (const s of Object.values(out.compose.services) as any[])
      if (s.environment) {
        if (Array.isArray(s.environment))
          s.environment = s.environment.map(
            (entry: string) => entry.split("=", 1)[0] + "=[redacted]",
          );
        else
          s.environment = Object.fromEntries(
            Object.keys(s.environment).map((k) => [k, "[redacted]"]),
          );
      }
  return out;
};
function preserveEnvironment(input: any, previous: any) {
  const c = structuredClone(input);
  if (c.environment)
    for (const [k, v] of Object.entries(c.environment))
      if (v === "[redacted]") {
        const prior = previous?.environment?.[k] ?? (previous?.mode === 'compose' ? previous?.compose?.services?.app?.environment?.[k] : undefined);
        if (typeof prior !== "string")
          fail(400, "environment_value_required");
        c.environment[k] = prior;
      }
  if (c.compose && typeof c.compose === "object")
    for (const [name, s] of Object.entries(c.compose.services ?? {}) as Array<
      [string, any]
    >) {
      if (s.environment && !Array.isArray(s.environment))
        for (const [k, v] of Object.entries(s.environment))
          if (v === "[redacted]") {
            const old = previous?.compose?.services?.[name]?.environment?.[k] ?? (name === 'app' && previous?.mode === 'container' ? previous?.environment?.[k] : undefined);
            if (typeof old !== "string")
              fail(400, "environment_value_required");
            s.environment[k] = old;
          }
    }
  return c;
}

export function createWorkloadController(options: PlatformOptions & {ensureCertificateMaterial?: (id:string,actor:string)=>Promise<void>}): DomainController {
  const {store,deps}=options;
  deps.db.exec(`CREATE TABLE IF NOT EXISTS ops_platform_ports(agent_id TEXT NOT NULL,protocol TEXT NOT NULL,port INTEGER NOT NULL,instance_id TEXT NOT NULL,PRIMARY KEY(agent_id,protocol,port));
    CREATE TABLE IF NOT EXISTS ops_platform_nodes(agent_id TEXT PRIMARY KEY,node_json TEXT NOT NULL,last_seen TEXT NOT NULL);`);
  const workloads=createClusterWorkloads(options);
  store.register('application', {
    validatePayload(resource,config,agentID) {
      if(!config.image_cache)return;
      const machineID=deps.db.get<{id:string}>('SELECT id FROM managed_machines WHERE agent_id=?',agentID)?.id;
      const expected=registryCacheFor(store,{...resource,spec:{...resource.spec,cluster_id:config.cluster_id}},machineID);
      if(JSON.stringify(expected)!==JSON.stringify(config.image_cache))fail(409,'private_registry_cache_policy_changed');
    },
    validate(spec,previous,context) {
      return workloads.validateApplication(preserveEnvironment(prepareApplicationYAML(spec,previous),previous),previous,context);
    },
    afterSave:workloads.afterSaveApplication,
    afterDelete:workloads.afterDeleteApplication,
    publicSpec:sanitizeEnvironment,
    beforeDelete:workloads.beforeDeleteApplication,
  });
  store.register('website', {
    publicSpec:publicWebsiteSpec,
    validate:workloads.validateWebsite,
    afterSave:workloads.afterSaveWebsite,
    afterDelete:workloads.afterDeleteWebsite,
    beforeDelete:workloads.beforeDeleteWebsite,
  });
  deps.router.get('/api/v1/ops/resources/:id/nginx',ctx=>{
    deps.auth.requireAdmin(ctx);
    const site=store.get(ctx.params.id,'website');
    ctx.res.setHeader('cache-control','no-store');
    ctx.json({revision:site.revision,config:workloads.preview(site,ctx.url.searchParams.get('cluster_id')??''),redacted:true,validated:false});
  });
  deps.router.get('/api/v1/ops/resources/:id/endpoints',ctx=>{
    deps.auth.requireAdmin(ctx);
    const app=store.get(ctx.params.id,'application'),name=ctx.url.searchParams.get('port_name')??undefined;
    if(name&&!app.spec.ports.some((p:any)=>p.name===name))fail(400,'application_port_not_found');
    ctx.res.setHeader('cache-control','no-store');
    const cid=ctx.url.searchParams.get('cluster_id');
    if(!cid)fail(400,'cluster_required');
    if(!app.spec.deployments.some((d:any)=>d.cluster_id===cid))fail(400,'application_not_deployed_in_cluster');
    ctx.json({service_name:app.spec.service_name,endpoints:workloads.endpoints(app.id,name,cid)});
  });
  return workloads;
}
