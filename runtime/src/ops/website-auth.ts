import { hashSync } from "bcryptjs";
import { authMaterial } from "../operations/basic-auth.js";
import { fail } from "../shared/http.js";
export function normalizeWebsiteAuth(
  raw: any,
  previous: any,
  location = false,
  trustedMaterial = false,
): any {
  if (raw === undefined)
    return previous ?? { mode: location ? "inherit" : "off" };
  if (trustedMaterial) return authMaterial(raw, location);
  if (raw?.mode !== "basic") return authMaterial(raw, location);
  if (!Array.isArray(raw.users) || raw.users.length > 20)
    fail(400, "invalid_website_auth_users");
  const users = raw.users.map((u: any) => {
    if (u.password_hash !== undefined)
      fail(400, "website_auth_hash_host_owned");
    const prior =
      previous?.mode === "basic"
        ? previous.users.find((p: any) => p.username === u.username)
        : undefined;
    const password = u.password;
    if (password !== undefined && typeof password !== "string")
      fail(400, "invalid_website_auth_password");
    if (password) {
      if (
        Buffer.byteLength(password) < 8 ||
        Buffer.byteLength(password) > 72 ||
        /[\r\n\0]/.test(password)
      )
        fail(400, "website_auth_password_length");
    }
    if (!password && !prior) fail(400, "website_auth_password_required");
    return {
      username: u.username,
      password_hash: password ? hashSync(password, 10) : prior.password_hash,
    };
  });
  return authMaterial(
    { mode: "basic", realm: raw.realm ?? "Restricted", users },
    location,
  );
}
export function publicWebsiteSpec(spec: any): any {
  const out = structuredClone(spec);
  const scrub = (auth: any) =>
    auth?.mode === "basic"
      ? {
          mode: "basic",
          realm: auth.realm,
          users: auth.users.map((u: any) => ({
            username: u.username,
            has_password: true,
          })),
        }
      : auth;
  out.auth = scrub(out.auth);
  for (const b of out.bindings ?? [])
    for (const l of b.locations ?? []) l.auth = scrub(l.auth);
  for (const l of out.locations ?? []) l.auth = scrub(l.auth);
  return out;
}
