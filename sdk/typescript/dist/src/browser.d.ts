export * from "./core.js";
import { type Options } from "./core.js";
export declare function installBrowserMonitor(options: Options, captureErrors?: boolean): {
    client: import("./core.js").LightMoni;
    shutdown(): Promise<void>;
};
