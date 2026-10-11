export * from "./core.js";
import { createLightMoni, type Options } from "./core.js";

// The browser token is public and write-only. Never embed the server/Agent Key.
export function installBrowserMonitor(options: Options, captureErrors = true) {
  const client = createLightMoni(options);
  const onError = (event: ErrorEvent) => client.log("error", event.message, { source: event.filename || "unknown", line: event.lineno, column: event.colno, stack: String(event.error?.stack ?? "").slice(0, 2000) });
  const onRejection = (event: PromiseRejectionEvent) => client.log("error", String(event.reason), { kind: "unhandledrejection" });
  const onHidden = () => { if (document.visibilityState === "hidden") void client.flush({ timeoutMs: 1000 }).catch(() => {}); };
  if (captureErrors) { window.addEventListener("error", onError); window.addEventListener("unhandledrejection", onRejection); }
  document.addEventListener("visibilitychange", onHidden);
  const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  if (navigation) {
    const timing = client.gauge("browser.navigation.duration", { unit: "ms" });
    if (navigation.duration > 0) timing.record(navigation.duration, { path: location.pathname });
  }
  return { client, async shutdown() { window.removeEventListener("error", onError); window.removeEventListener("unhandledrejection", onRejection); document.removeEventListener("visibilitychange", onHidden); await client.shutdown(); } };
}
