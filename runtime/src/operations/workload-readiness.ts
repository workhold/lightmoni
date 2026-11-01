/** Only the authorized manifest can declare one-shot initialization services. */
const label = "io.lightmoni.platform.oneshot";
export function oneShotServices(services: Record<string, any> = {}) {
  return Object.entries(services)
    .filter(([, s]) =>
      Array.isArray(s.labels)
        ? s.labels.includes(label + "=true")
        : s.labels?.[label] === "true",
    )
    .map(([name]) => name);
}
export function workloadContainersReady(
  containers: any[],
  count: number,
  services?: Record<string, any>,
): boolean {
  if (containers.length < count || !containers.length) return false;
  const init = new Set(oneShotServices(services));
  const names = containers.map(
    (c) => c.Config?.Labels?.["com.docker.compose.service"],
  );
  if (services && Object.keys(services).some((name) => !names.includes(name)))
    return false;
  return containers.every((c) => {
    const name = c.Config?.Labels?.["com.docker.compose.service"];
    if (init.has(name))
      return (
        c.Config?.Labels?.[label] === "true" &&
        c.State?.Status === "exited" &&
        c.State?.Running === false &&
        c.State?.ExitCode === 0 &&
        c.State?.OOMKilled !== true
      );
    return (
      c.State?.Running === true &&
      (!c.State?.Health || c.State.Health.Status === "healthy")
    );
  });
}
