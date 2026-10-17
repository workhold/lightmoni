import type { Dependencies, Module } from "../shared/types.js";
import { registerDashboards } from "./dashboards.js";
import { registerLogs } from "./logs.js";
import { registerAlerts } from "./alerts.js";
export { registerDashboards, registerLogs, registerAlerts };
export function registerDomains(deps: Dependencies): Module {
  const modules: Module[] = [
    registerDashboards(deps),
    registerLogs(deps),
    registerAlerts(deps),
  ];
  return {
    async start() {
      for (const m of modules) await m.start?.();
    },
    async close() {
      for (const m of [...modules].reverse()) await m.close?.();
    },
  };
}
