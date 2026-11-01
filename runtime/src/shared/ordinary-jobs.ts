/** Shared fixed boundary; capabilities offered by callers never grant writes. */
export const ORDINARY_JOB_CAPABILITIES = Object.freeze([
  "health.systemd", "health.http", "health.tcp", "systemd.probe", "docker.inventory",
]);
export const ordinaryReadOnlyJob = (job: any): boolean => {
  if (!Array.isArray(job?.capabilities) || !Array.isArray(job.actions) || !job.actions.length
    || job.capabilities.some((cap: unknown) => typeof cap !== "string" || !ORDINARY_JOB_CAPABILITIES.includes(cap))) return false;
  return job.actions.every((action: any) => {
    if (!action || typeof action !== "object" || Array.isArray(action)) return false;
    if (action.kind === "docker") return job.actions.length === 1 && action.operation === "inventory"
      && Object.keys(action).every(key => ["kind", "operation"].includes(key)) && job.capabilities.includes("docker.inventory");
    if (action.kind === "systemd_probe") return job.capabilities.includes("systemd.probe");
    if (action.kind === "health_check") {
      const capability = action.check?.kind === "systemd-active" ? "health.systemd"
        : action.check?.kind === "http" ? "health.http" : action.check?.kind === "tcp" ? "health.tcp" : "";
      return !!capability && job.capabilities.includes(capability);
    }
    return false;
  });
};

