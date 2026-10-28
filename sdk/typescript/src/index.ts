import { AsyncLocalStorage } from "node:async_hooks";
import { createLightMoni as createCore, extractTrace, injectTrace, type LightMoni, type Options, type TraceContext } from "./core.js";
export * from "./core.js";
const context = new AsyncLocalStorage<TraceContext>();
export function createLightMoni(options: Options) {
  // Public telemetry declarations only; these values never authenticate a host.
  const resource = { ...options.resource };
  for (const [variable, attribute, maxBytes] of [
    ["LIGHTMONI_MACHINE_ID", "lightmoni.machine.id", 64],
    ["LIGHTMONI_MACHINE_NAME", "lightmoni.machine.name", 128],
  ] as const) {
    const value = process.env[variable];
    if (!Object.hasOwn(resource, attribute) && value?.trim() && Buffer.byteLength(value, "utf8") <= maxBytes && !/\p{Cc}/u.test(value)) resource[attribute] = value;
  }
  return createCore({ endpoint:process.env.LIGHTMONI_ENDPOINT??"http://127.0.0.1:4318",key:process.env.LIGHTMONI_KEY,...options, resource, contextProvider: () => context.getStore() ?? options.contextProvider?.(), contextRunner: options.contextRunner ?? withTrace });
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
