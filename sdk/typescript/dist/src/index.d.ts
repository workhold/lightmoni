import { type LightMoni, type Options, type TraceContext } from "./core.js";
export * from "./core.js";
export declare function createLightMoni(options: Options): LightMoni;
/** Node-only environment constructor. Secret files are never persisted by the SDK. */
export declare function createLightMoniFromEnv(options: Omit<Options, "endpoint" | "key" | "mode" | "agentEndpoint" | "localToken"> & Partial<Pick<Options, "endpoint" | "key" | "mode" | "agentEndpoint" | "localToken">>): LightMoni;
export declare function withTrace<T>(trace: TraceContext, action: () => T): T;
/** Wrap an HTTP handler once; all nested SDK logs inherit its trace. */
export declare function traceHandler<A extends unknown[], R>(client: LightMoni, name: string, handler: (...args: A) => R, headers: (...args: A) => Headers | Record<string, string | undefined>): (...args: A) => R;
