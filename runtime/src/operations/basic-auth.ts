import { OperationRejectedError } from "./errors.js";
export type BasicAuth =
  | {
      mode: "basic";
      realm: string;
      users: { username: string; password_hash: string }[];
    }
  | { mode: "off" | "inherit" };
const invalid = (): never => {
  throw new OperationRejectedError("INVALID_WEBSITE_AUTH");
};
/** Agent accepts hashes only. Passwords are consumed by the host's write boundary. */
export function authMaterial(raw: any, location = false): BasicAuth {
  if (raw === undefined) return { mode: location ? "inherit" : "off" };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return invalid();
  if (raw.mode === "off" || (location && raw.mode === "inherit"))
    return { mode: raw.mode };
  if (
    raw.mode !== "basic" ||
    typeof raw.realm !== "string" ||
    !raw.realm.length ||
    raw.realm.length > 100 ||
    /[\r\n\0$]/.test(raw.realm) ||
    !Array.isArray(raw.users) ||
    !raw.users.length ||
    raw.users.length > 20
  )
    return invalid();
  const seen = new Set<string>();
  const users = raw.users.map((u: any) => {
    if (
      !u ||
      !/^[A-Za-z0-9][A-Za-z0-9_.@-]{0,63}$/.test(u.username) ||
      seen.has(u.username) ||
      typeof u.password_hash !== "string" ||
      !/^\$2[aby]\$(10|11|12)\$[./A-Za-z0-9]{53}$/.test(u.password_hash) ||
      u.password !== undefined
    )
      return invalid();
    seen.add(u.username);
    return { username: u.username, password_hash: u.password_hash };
  });
  return { mode: "basic", realm: raw.realm, users };
}
export function effectiveAuth(site: any, route: any): BasicAuth {
  const local = authMaterial(route, true);
  return local.mode === "inherit" ? authMaterial(site) : local;
}
export function authScopes(
  site: any,
): { key: string; auth: Extract<BasicAuth, { mode: "basic" }> }[] {
  const out: { key: string; auth: Extract<BasicAuth, { mode: "basic" }> }[] =
    [];
  const global = authMaterial(site.auth);
  if (global.mode === "basic") out.push({ key: "site", auth: global });
  for (const [i, route] of (site.locations ?? []).entries()) {
    const auth = authMaterial(route.auth, true);
    if (auth.mode === "basic") out.push({ key: "route-" + i, auth });
  }
  return out;
}
