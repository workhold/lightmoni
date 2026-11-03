import { AsyncLocalStorage } from "node:async_hooks";
import { createLightMoni as createCore, extractTrace, injectTrace, type LightMoni, type Options, type TraceContext } from "./core.js";
export * from "./core.js";
const context = new AsyncLocalStorage<TraceContext>();
export type NodeOptions = Omit<Options,'service'> & {service?:string};
export function createLightMoni(options: NodeOptions = {}) {
  const fields:Record<string,string>={LIGHTMONI_MACHINE_NAME:'host.name',LIGHTMONI_MACHINE_ID:'lightmoni.machine_id',LIGHTMONI_HOST_ID:'host.id',LIGHTMONI_AGENT_ID:'lightmoni.agent_id',LIGHTMONI_APPLICATION_ID:'lightmoni.application_id',LIGHTMONI_CLUSTER_ID:'lightmoni.cluster_id',LIGHTMONI_DEPLOYMENT_ID:'lightmoni.deployment_id'};
  const resource=Object.fromEntries(Object.entries(fields).flatMap(([variable,key])=>process.env[variable]?[[key,process.env[variable]!]]:[]));
  return createCore({...options,service:options.service??process.env.LIGHTMONI_SERVICE??'',endpoint:options.endpoint??process.env.LIGHTMONI_ENDPOINT,key:options.key??process.env.LIGHTMONI_KEY,instance_id:options.instance_id??options.instanceId??process.env.LIGHTMONI_INSTANCE_ID,env:options.env??process.env.LIGHTMONI_ENV,service_version:options.service_version??process.env.LIGHTMONI_SERVICE_VERSION,resource:{...resource,...options.resource},contextProvider:()=>context.getStore()??options.contextProvider?.(),contextRunner:options.contextRunner??withTrace});
}
export function withTrace<T>(trace: TraceContext, action: () => T): T {
  // Validation and a snapshot prevent caller mutation from changing a scope.
  injectTrace(trace);
  return context.run(Object.freeze({ ...trace }), action);
}

/** Wrap an HTTP handler once; all nested SDK logs inherit its trace. */
export function traceHandler<A extends unknown[], R>(client: LightMoni, name: string, handler: (...args: A) => R, headers: (...args: A) => Headers | Record<string, string | undefined>) {
  return (...args: A): R => client.withSpan(name, (_scoped, span) => { span.setKind(2); return handler(...args); }, {}, extractTrace(headers(...args)) ?? null);
}

export {CenterEndpoints, centerURL, type CenterEndpoint, type EndpointSnapshot} from "./endpoints.js";
