import { type Options, type TraceContext } from "./core.js";
export * from "./core.js";
export declare function createLightMoni(options: Options): import("./core.js").LightMoni;
export declare function withTrace<T>(trace: TraceContext, action: () => T): T;
