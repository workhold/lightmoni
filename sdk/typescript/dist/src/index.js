import { AsyncLocalStorage } from "node:async_hooks";
import { createLightMoni as createCore, extractTrace, injectTrace } from "./core.js";
export * from "./core.js";
const context = new AsyncLocalStorage();
export function createLightMoni(options) { return createCore({ ...options, contextProvider: () => context.getStore() ?? options.contextProvider?.(), contextRunner: options.contextRunner ?? withTrace }); }
export function withTrace(trace, action) {
    // Validation and a snapshot prevent caller mutation from changing a scope.
    injectTrace(trace);
    return context.run(Object.freeze({ ...trace }), action);
}
/** Wrap an HTTP handler once; all nested SDK logs inherit its trace. */
export function traceHandler(client, name, handler, headers) {
    return (...args) => client.withSpan(name, (_scoped, span) => { span.setKind(2); return handler(...args); }, {}, extractTrace(headers(...args)) ?? null);
}
