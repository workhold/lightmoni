import { AsyncLocalStorage } from "node:async_hooks";
import { createLightMoni as createCore, type Options, type TraceContext } from "./core.js";
export * from "./core.js";
const context = new AsyncLocalStorage<TraceContext>();
export function createLightMoni(options: Options) { return createCore({ ...options, contextProvider: options.contextProvider ?? (() => context.getStore()) }); }
export function withTrace<T>(trace: TraceContext, action: () => T): T { return context.run(trace, action); }
