import { AsyncLocalStorage } from "node:async_hooks";
import { createLightMoni as createCore, extractTrace, injectTrace, type LightMoni, type Options, type TraceContext } from "./core.js";
export * from "./core.js";
const context = new AsyncLocalStorage<TraceContext>();
export function createLightMoni(options: Options) { return createCore({ ...options, contextProvider: () => context.getStore() ?? options.contextProvider?.(), contextRunner: options.contextRunner ?? withTrace }); }
export function withTrace<T>(trace: TraceContext, action: () => T): T {
  // Validation and a snapshot prevent caller mutation from changing a scope.
  injectTrace(trace);
  return context.run(Object.freeze({ ...trace }), action);
}

/** Wrap an HTTP handler once; all nested SDK logs inherit its trace. */
export function traceHandler<A extends unknown[], R>(client: LightMoni, name: string, handler: (...args: A) => R, headers: (...args: A) => Headers | Record<string, string | undefined>) {
  return (...args: A): R => client.withSpan(name, (_scoped, span) => { span.setKind(2); return handler(...args); }, {}, extractTrace(headers(...args)) ?? null);
}
