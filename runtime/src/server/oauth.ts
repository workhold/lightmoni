import { createHash } from "node:crypto";
import { token, id } from "../shared/crypto.js";
import { fail, HTTPError } from "../shared/http.js";
import { parseJSON } from "../shared/json.js";
import { isLosslessNumber } from "lossless-json";
import { cookie, type Auth } from "./auth.js";
import { notificationProfile, validateContact } from "./profiles.js";
import type { Context } from "../shared/types.js";
type Provider = Record<string, any>;
class OAuthError extends Error {}
const stringFields = [
  "name",
  "kind",
  "client_id",
  "client_secret",
  "authorize_url",
  "token_url",
  "userinfo_url",
  "subject_field",
  "name_field",
  "scopes",
  "email_field",
  "phone_field",
  "feishu_id_field",
  "dingtalk_id_field",
  "wecom_id_field",
];
const booleanFields = ["enabled", "pkce", "auto_approve"];
function providerInput(value: any): Provider {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(400, "invalid provider");
  const p: Provider = {};
  for (const k of stringFields) {
    if (value[k] != null && typeof value[k] !== "string")
      fail(400, "invalid provider");
    p[k] = value[k] ?? "";
  }
  for (const k of booleanFields) {
    if (value[k] != null && typeof value[k] !== "boolean")
      fail(400, "invalid provider");
    p[k] = value[k] ?? false;
  }
  return p;
}

const defaults = (p: Provider): Provider => {
  if (p.kind === "github")
    Object.assign(p, {
      authorize_url: "https://github.com/login/oauth/authorize",
      token_url: "https://github.com/login/oauth/access_token",
      userinfo_url: "https://api.github.com/user",
      subject_field: "id",
      name_field: "login",
      pkce: true,
    });
  if (p.kind === "qq")
    Object.assign(p, {
      authorize_url: "https://graph.qq.com/oauth2.0/authorize",
      token_url: "https://graph.qq.com/oauth2.0/token",
      userinfo_url: "https://graph.qq.com/oauth2.0/me",
      subject_field: "openid",
      name_field: "openid",
      scopes: "get_user_info",
    });
  if (p.kind === "wechat")
    Object.assign(p, {
      authorize_url: "https://open.weixin.qq.com/connect/qrconnect",
      token_url: "https://api.weixin.qq.com/sns/oauth2/access_token",
      userinfo_url: "https://api.weixin.qq.com/sns/userinfo",
      subject_field: "openid",
      name_field: "nickname",
      scopes: "snsapi_login",
    });
  return p;
};
export const field = (v: any, path: string): string => {
  for (const key of (path ?? "").split(".")) {
    if (v === null || typeof v !== "object" || !Object.hasOwn(v, key))
      return "";
    v = v[key];
  }
  return typeof v === "string" ||
    typeof v === "number" ||
    typeof v === "boolean" ||
    isLosslessNumber(v)
    ? String(v)
    : "";
};
export function safeReturnTarget(s: string) {
  if (
    !s ||
    s.length > 8192 ||
    !s.startsWith("/") ||
    s.startsWith("//") ||
    /[\\\x00-\x1f\x7f]/.test(s)
  )
    return false;
  try {
    const u = new URL(s, "https://local");
    return (
      u.origin === "https://local" &&
      (u.pathname === "/" ||
        u.pathname === "/alerts" ||
        u.pathname.startsWith("/traces/") ||
        u.pathname.startsWith("/a/"))
    );
  } catch {
    return false;
  }
}
function redirect(c: Context, location: string) {
  c.res.writeHead(302, { location });
  c.res.end();
}
async function providerRequest(
  c: Context,
  method: string,
  endpoint: string,
  form: Record<string, string>,
  access = "",
) {
  const url = new URL(endpoint),
    body = new URLSearchParams(form);
  if (method === "GET") for (const [k, v] of body) url.searchParams.set(k, v);
  let response: Response;
  try {
    response = await fetch(url, {
      redirect: "error",
      method,
      body: method === "GET" ? undefined : body,
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
        ...(access ? { authorization: "Bearer " + access } : {}),
      },
      signal: AbortSignal.any([c.signal, AbortSignal.timeout(10000)]),
    });
  } catch {
    throw new OAuthError("供应商网络请求失败");
  }
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const part of response.body ?? []) {
    size += part.length;
    if (size > 1 << 20) throw new OAuthError("供应商响应过大");
    parts.push(part);
  }
  if (!response.ok)
    throw new OAuthError("供应商返回错误 (" + response.status + ")");
  const text = Buffer.concat(parts).toString(),
    start = text.indexOf("{"),
    end = text.lastIndexOf("}");
  if (start >= 0 && end >= start) {
    try {
      return parseJSON<any>(text.slice(start, end + 1));
    } catch {}
  }
  return Object.fromEntries(new URLSearchParams(text));
}
export function registerOAuth(a: Auth) {
  const r = a.router,
    db = a.db;
  const providers = (secret = false) =>
    db.all<any>("SELECT config FROM oauth_providers ORDER BY id").map((row) => {
      const p = JSON.parse(row.config);
      if (secret) p.client_secret = a.decrypt(p.client_secret);
      else delete p.client_secret;
      return p;
    });
  const provider = (uid: string) => {
    const p = providers(true).find((p) => p.id === uid && p.enabled);
    if (!p) fail(404, "login provider unavailable");
    return p;
  };
  r.get("/api/v1/settings/login-providers", (c) => {
    a.requireAdmin(c);
    c.json(providers());
  });
  r.put("/api/v1/settings/login-providers/:id", async (c) => {
    a.requireAdmin(c);
    const p = providerInput(await c.body());
    p.id = c.params.id;
    if (!["github", "qq", "wechat", "oauth2"].includes(p.kind))
      fail(400, "unsupported provider");
    defaults(p);
    for (const key of [
      "name",
      "client_id",
      "authorize_url",
      "token_url",
      "userinfo_url",
      "subject_field",
    ])
      if (!p[key]) fail(400, "完整供应商配置必填");
    for (const key of ["authorize_url", "token_url", "userinfo_url"]) {
      try {
        const u = new URL(p[key]);
        if (
          !["http:", "https:"].includes(u.protocol) ||
          !u.host ||
          u.username ||
          u.password
        )
          throw new OAuthError();
      } catch {
        fail(400, "invalid provider endpoint");
      }
    }
    if (p.client_secret) p.client_secret = a.encrypt(p.client_secret);
    else {
      const row = db.get<any>(
        "SELECT config FROM oauth_providers WHERE id=?",
        p.id,
      );
      p.client_secret = row ? JSON.parse(row.config).client_secret : "";
    }
    if (!p.client_secret) fail(400, "Client secret必填");
    db.run(
      "INSERT INTO oauth_providers(id,config) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET config=excluded.config",
      p.id,
      JSON.stringify(p),
    );
    delete p.client_secret;
    c.json(p);
  });
  r.delete("/api/v1/settings/login-providers/:id", (c) => {
    a.requireAdmin(c);
    db.run("DELETE FROM oauth_providers WHERE id=?", c.params.id);
    c.json({ ok: true });
  });
  r.get("/api/v1/auth/identities", (c) =>
    c.json(
      db.all(
        "SELECT provider_id,subject FROM external_identities WHERE user_id=?",
        c.user.id,
      ),
    ),
  );
  r.get(
    "/api/v1/auth/providers",
    (c) =>
      c.json(
        providers()
          .filter((p) => p.enabled)
          .map((p) => ({ id: p.id, name: p.name, kind: p.kind })),
      ),
    { public: true },
  );
  r.get(
    "/api/v1/auth/oauth/:id/start",
    (c) => {
      const p = provider(c.params.id),
        state = token(),
        verifier = token();
      let user = "";
      if (c.url.searchParams.get("bind") === "1") {
        const u = a.user(c.req);
        if (!u) fail(401, "绑定需要先登录");
        user = u.id;
      }
      const target = c.url.searchParams.get("return_to") ?? "";
      db.transaction(() => {
        db.run(
          "INSERT INTO oauth_states(state,provider_id,verifier,created_at,user_id) VALUES(?,?,?,?,?)",
          state,
          p.id,
          verifier,
          Math.floor(Date.now() / 1000),
          user,
        );
        if (safeReturnTarget(target))
          db.run(
            "INSERT INTO oauth_return_targets(state,return_to) VALUES(?,?)",
            state,
            target,
          );
        db.run(
          "DELETE FROM oauth_states WHERE created_at<?",
          Math.floor(Date.now() / 1000) - 600,
        );
        db.run(
          "DELETE FROM oauth_return_targets WHERE state NOT IN (SELECT state FROM oauth_states)",
        );
      });
      c.res.setHeader(
        "set-cookie",
        "lm_oauth_state=" +
          state +
          "; Path=/api/v1/auth/oauth; HttpOnly; SameSite=Lax; Max-Age=600" +
          (a.externalURL.startsWith("https:") ? "; Secure" : ""),
      );
      const u = new URL(p.authorize_url);
      for (const [k, v] of Object.entries({
        response_type: "code",
        client_id: p.client_id,
        redirect_uri:
          a.externalURL + "/api/v1/auth/oauth/" + p.id + "/callback",
        state,
      }))
        u.searchParams.set(k, v);
      if (p.scopes) u.searchParams.set("scope", p.scopes);
      if (p.pkce) {
        u.searchParams.set(
          "code_challenge",
          createHash("sha256").update(verifier).digest("base64url"),
        );
        u.searchParams.set("code_challenge_method", "S256");
      }
      if (p.kind === "wechat") {
        u.searchParams.delete("client_id");
        u.searchParams.set("appid", p.client_id);
        u.hash = "wechat_redirect";
      }
      redirect(c, u.toString());
    },
    { public: true },
  );
  r.get(
    "/api/v1/auth/oauth/:id/callback",
    async (c) => {
      const error = (message: string) =>
        redirect(c, "/login?oauth_error=" + encodeURIComponent(message));
      const state = c.url.searchParams.get("state") ?? "";
      if (!state || cookie(c.req, "lm_oauth_state") !== state) {
        error("登录状态无效，请重试");
        return;
      }
      let stored: any,
        target = "";
      db.transaction(() => {
        stored = db.get<any>("SELECT * FROM oauth_states WHERE state=?", state);
        target =
          db.get<any>(
            "SELECT return_to FROM oauth_return_targets WHERE state=?",
            state,
          )?.return_to ?? "";
        db.run("DELETE FROM oauth_return_targets WHERE state=?", state);
        db.run("DELETE FROM oauth_states WHERE state=?", state);
      });
      if (
        !stored ||
        stored.created_at < Math.floor(Date.now() / 1000) - 600 ||
        stored.provider_id !== c.params.id
      ) {
        error("登录回调已过期");
        return;
      }
      const code = c.url.searchParams.get("code");
      if (!code) {
        error("已取消第三方授权");
        return;
      }
      try {
        if (stored.user_id && a.user(c.req)?.id !== stored.user_id)
          throw new OAuthError("绑定会话已变化");
        const p = provider(stored.provider_id),
          form: Record<string, string> = {
            client_id: p.client_id,
            client_secret: p.client_secret,
            grant_type: "authorization_code",
            code,
            redirect_uri:
              a.externalURL + "/api/v1/auth/oauth/" + p.id + "/callback",
          };
        if (p.pkce) form.code_verifier = stored.verifier;
        if (p.kind === "wechat") {
          delete form.client_id;
          delete form.client_secret;
          form.appid = p.client_id;
          form.secret = p.client_secret;
        }
        const tokens = await providerRequest(
            c,
            ["qq", "wechat"].includes(p.kind) ? "GET" : "POST",
            p.token_url,
            form,
          ),
          access = field(tokens, "access_token");
        if (!access) throw new OAuthError("供应商未返回有效授权");
        const params: Record<string, string> = {};
        if (["qq", "wechat"].includes(p.kind)) params.access_token = access;
        if (p.kind === "wechat") {
          params.openid = field(tokens, "openid");
          params.lang = "zh_CN";
        }
        const identity = await providerRequest(
            c,
            "GET",
            p.userinfo_url,
            params,
            access,
          ),
          subject = field(identity, p.subject_field);
        if (!subject) throw new OAuthError("供应商未返回稳定身份");
        if (stored.user_id) {
          if (a.user(c.req)?.id !== stored.user_id)
            throw new OAuthError("绑定会话已变化");
          try {
            db.run(
              "INSERT INTO external_identities(provider_id,subject,user_id) VALUES(?,?,?)",
              p.id,
              subject,
              stored.user_id,
            );
          } catch {
            throw new OAuthError("该外部身份已绑定");
          }
          redirect(c, "/settings?tab=users");
          return;
        }
        let uid = db.get<any>(
          "SELECT user_id FROM external_identities WHERE provider_id=? AND subject=?",
          p.id,
          subject,
        )?.user_id;
        if (!uid) {
          uid = id();
          db.transaction(() => {
            db.run(
              "INSERT INTO users(id,name,role,active,created_at) VALUES(?,?,'member',?,?)",
              uid,
              (field(identity, p.name_field) || p.name) + "-" + uid.slice(0, 6),
              !!p.auto_approve,
              new Date().toISOString(),
            );
            db.run(
              "INSERT INTO external_identities(provider_id,subject,user_id) VALUES(?,?,?)",
              p.id,
              subject,
              uid,
            );
          });
        }
        if (!db.get<any>("SELECT active FROM users WHERE id=?", uid)?.active)
          throw new OAuthError("账号等待管理员启用");
        let contact = notificationProfile(a, uid);
        if (contact.source !== "manual") {
          for (const key of [
            "email",
            "phone",
            "feishu_id",
            "dingtalk_id",
            "wecom_id",
          ])
            if (p[key + "_field"])
              contact[key] = field(identity, p[key + "_field"]);
          contact = validateContact(contact);
          Object.assign(contact, {
            source: "sso:" + p.id,
            updated_at: new Date().toISOString(),
          });
          db.run(
            "INSERT INTO user_notification_profiles(user_id,body) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET body=excluded.body",
            uid,
            JSON.stringify(contact),
          );
        }
        a.session(c, uid);
        redirect(c, safeReturnTarget(target) ? target : "/");
      } catch (e) {
        error(
          e instanceof OAuthError || (e instanceof HTTPError && e.status < 500)
            ? e.message
            : "第三方登录失败",
        );
      }
    },
    { public: true },
  );
}
