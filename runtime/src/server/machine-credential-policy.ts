export interface MachineCredentialLifetime {
  retention: string;
  expires_at: string;
}

// An empty deadline is meaningful only for explicitly confirmed permanent
// credentials. Missing or malformed finite deadlines always fail closed.
export function machineCredentialCurrent(credential: MachineCredentialLifetime, now: Date): boolean {
  if (credential.retention === "permanent") return credential.expires_at === "";
  if (!["temporary", "managed", "one_time"].includes(credential.retention)) return false;
  const expires = Date.parse(credential.expires_at);
  return Number.isFinite(expires) && expires > now.getTime();
}

// Each use consumes exactly one ISO timestamp parameter. COALESCE keeps NOT
// current useful during cleanup, including malformed historical deadlines.
export function machineCredentialCurrentSQL(alias: "c" | "" = ""): string {
  const prefix = alias ? `${alias}.` : "";
  return `COALESCE(((${prefix}retention='permanent' AND ${prefix}expires_at='') OR (${prefix}retention IN ('temporary','managed','one_time') AND julianday(${prefix}expires_at)>julianday(?))),0)`;
}
