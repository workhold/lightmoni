import { AsyncLocalStorage } from "node:async_hooks";
import { createLightMoni as createCore } from "./core.js";
export * from "./core.js";
const context = new AsyncLocalStorage();
export function createLightMoni(options) { return createCore({ ...options, contextProvider: options.contextProvider ?? (() => context.getStore()) }); }
export function withTrace(trace, action) { return context.run(trace, action); }
