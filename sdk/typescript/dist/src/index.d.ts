import { type LightMoni, type Options, type TraceContext } from "./core.js";
export * from "./core.js";
export declare function createLightMoni(options: Options): LightMoni;
export declare function withTrace<T>(trace: TraceContext, action: () => T): T;
/** Wrap an HTTP handler once; all nested SDK logs inherit its trace. */
export declare function traceHandler<A extends unknown[], R>(client: LightMoni, name: string, handler: (...args: A) => R, headers: (...args: A) => Headers | Record<string, string | undefined>): (...args: A) => R;
export { CenterEndpoints, centerURL, type CenterEndpoint, type EndpointSnapshot } from "./endpoints.js";
