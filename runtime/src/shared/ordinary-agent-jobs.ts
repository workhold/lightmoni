import { posix } from "node:path";

/** Ordinary control credentials never authorize host writes or daemon access. */
export const ORDINARY_JOB_CAPABILITIES = Object.freeze([
  "health.systemd", "health.http", "health.tcp", "systemd.probe",
]);
const record = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const keys = (v: Record<string, any>, names: string[]) => Object.keys(v).every(k => names.includes(k));
const unit = (v: unknown) => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_.@:-]{0,126}\.service$/.test(v);
const timeout = (v: unknown) => v === undefined || Number.isInteger(v) && Number(v) >= 1 && Number(v) <= 30_000;
const absolute = (v: unknown) => typeof v === "string" && v.startsWith("/") && v !== "/" && !/[\0\r\n\\]/.test(v) && posix.normalize(v) === v && !v.split("/").includes("..");

export function ordinaryReadOnlyJob(job: unknown): boolean {
  if (!record(job) || !Array.isArray(job.capabilities) || !job.capabilities.length || !Array.isArray(job.actions)
    || !job.actions.length || job.actions.length > 64 || new Set(job.capabilities).size !== job.capabilities.length
    || job.capabilities.some((cap: unknown) => typeof cap !== "string" || !ORDINARY_JOB_CAPABILITIES.includes(cap))) return false;
  const required = new Set<string>();
  for (const action of job.actions) {
    if (!record(action)) return false;
    if (action.kind === "systemd_probe") {
      if (job.actions.length !== 1 || !keys(action, ["kind", "unit", "releaseDirectory", "preflightID", "targetRevision"])
        || !unit(action.unit) || !absolute(action.releaseDirectory) || !/^[a-f0-9]{32}$/.test(action.preflightID ?? "")
        || !/^[a-f0-9]{64}$/i.test(action.targetRevision ?? "")) return false;
      required.add("systemd.probe");
    } else if (action.kind === "health_check" && keys(action, ["kind", "check"]) && record(action.check)) {
      const check = action.check;
      if (check.kind === "systemd-active") {
        if (!keys(check, ["kind", "unit"]) || !unit(check.unit)) return false;
        required.add("health.systemd");
      } else if (check.kind === "http") {
        if (!keys(check, ["kind", "url", "timeoutMs", "expectedStatus"]) || typeof check.url !== "string" || check.url.length > 2048 || !timeout(check.timeoutMs)
          || check.expectedStatus !== undefined && (!Number.isInteger(check.expectedStatus) || check.expectedStatus < 100 || check.expectedStatus > 599)) return false;
        try { const url = new URL(check.url); if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return false; } catch { return false; }
        required.add("health.http");
      } else if (check.kind === "tcp") {
        if (!keys(check, ["kind", "host", "port", "timeoutMs"]) || typeof check.host !== "string" || !/^[A-Za-z0-9_.:-]{1,253}$/.test(check.host)
          || !Number.isInteger(check.port) || check.port < 1 || check.port > 65535 || !timeout(check.timeoutMs)) return false;
        required.add("health.tcp");
      } else return false;
    } else return false;
  }
  return required.size === job.capabilities.length && job.capabilities.every((cap: string) => required.has(cap));
}
