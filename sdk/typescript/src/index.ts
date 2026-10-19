import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync, lstatSync } from "node:fs";
import { createLightMoni as createCore, extractTrace, injectTrace, type LightMoni, type Options, type TraceContext } from "./core.js";
export * from "./core.js";
const context = new AsyncLocalStorage<TraceContext>();
export function createLightMoni(options: Options) { return createCore({ ...options, contextProvider: () => context.getStore() ?? options.contextProvider?.(), contextRunner: options.contextRunner ?? withTrace }); }

function secret(explicit: string | undefined, file: string | undefined, env: string, fileEnv: string): { value?: string; source?: "explicit" | "file" | "env" } {
  const path = file || process.env[fileEnv]; let fromFile = "";
  if (path) { const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${env} file must be a regular file`); const raw = readFileSync(path); if (raw.length > 16 * 1024) throw new Error(`${env} file is too large`); fromFile = raw.toString("utf8").replace(/\r?\n$/, ""); }
  const fromEnv = process.env[env] || ""; const values = [explicit || "", fromFile, fromEnv].filter(Boolean); if (new Set(values).size > 1) throw new Error(`credential_source_conflict: ${env}`);
  return explicit ? { value: explicit, source: "explicit" } : fromFile ? { value: fromFile, source: "file" } : fromEnv ? { value: fromEnv, source: "env" } : {};
}

/** Node-only environment constructor. Secret files are never persisted by the SDK. */
export function createLightMoniFromEnv(options: Omit<Options, "endpoint" | "key" | "mode" | "agentEndpoint" | "localToken"> & Partial<Pick<Options, "endpoint" | "key" | "mode" | "agentEndpoint" | "localToken">>) {
  const mode = options.mode ?? (process.env.LIGHTMONI_MODE as Options["mode"]) ?? "direct";
  if (!["agent", "direct", "auto"].includes(mode)) throw new Error("mode must be agent, direct, or auto");
  const endpoint = mode === "agent" ? (options.exporter ? options.endpoint : undefined) : options.endpoint || process.env.LIGHTMONI_ENDPOINT;
  const agentEndpoint = mode === "direct" ? undefined : options.agentEndpoint || process.env.LIGHTMONI_AGENT_ENDPOINT || "http://127.0.0.1:4318";
  const local = mode === "direct" ? {} : secret(options.localToken, undefined, "LIGHTMONI_LOCAL_TOKEN", "LIGHTMONI_LOCAL_TOKEN_FILE");
  const data = mode === "agent" ? {} : secret(options.key, undefined, "LIGHTMONI_DATA_KEY", "LIGHTMONI_DATA_KEY_FILE");
  const legacy = mode === "agent" ? {} : secret(undefined, undefined, "LIGHTMONI_KEY", "");
  if (data.value && legacy.value && data.value !== legacy.value) throw new Error("credential_source_conflict: LIGHTMONI_KEY");
  if (mode === "direct" && (!endpoint || !(data.value || legacy.value))) throw new Error("direct mode requires endpoint and data key");
  if (mode === "auto" && !endpoint && !agentEndpoint) throw new Error("auto_route_unavailable: configure an Agent or direct credentials");
  const key = mode === "agent" && options.exporter ? options.key : data.value || legacy.value;
  return createLightMoni({ ...options, mode, endpoint, agentEndpoint, localToken: local.value, key });
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
