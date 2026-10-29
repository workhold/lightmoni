import { isIP } from "node:net";
import { OperationRejectedError } from "./errors.js";

type Config = Record<string, any>;
const bad = (code: string): never => {
  throw new OperationRejectedError(code);
};
const obj = (v: any): Config =>
  v && typeof v === "object" && !Array.isArray(v)
    ? v
    : bad("INVALID_NGINX_OBJECT");
const str = (v: any, max = 4096): string =>
  typeof v === "string" && v.length <= max && !/[\r\n\0]/.test(v)
    ? v
    : bad("INVALID_NGINX_VALUE");
const num = (v: any, fallback: number, max = 86400, min = 0): number =>
  v === undefined
    ? fallback
    : typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max
      ? v
      : bad("INVALID_NGINX_NUMBER");
const choice = (v: any, options: string[], fallback: string): string =>
  v === undefined
    ? fallback
    : options.includes(v)
      ? v
      : bad("INVALID_NGINX_OPTION");
const flag = (v: any, fallback: boolean): boolean =>
  v === undefined
    ? fallback
    : typeof v === "boolean"
      ? v
      : bad("INVALID_NGINX_BOOLEAN");
const list = (v: any, max = 100): any[] =>
  v === undefined
    ? []
    : Array.isArray(v) && v.length <= max
      ? v
      : bad("NGINX_LIST_LIMIT");
export const nginxQuote = (v: string) =>
  '"' + str(v).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
function headers(v: any): Record<string, string> {
  const entries = Object.entries(obj(v ?? {}));
  if (entries.length > 50) bad("NGINX_HEADER_LIMIT");
  const seen = new Set<string>();
  return Object.fromEntries(
    entries.map(([key, value]) => {
      if (
        !/^[!#$%&'*+.^_`|~A-Za-z0-9-]{1,100}$/.test(key) ||
        seen.has(key.toLowerCase())
      )
        bad("INVALID_NGINX_HEADER");
      seen.add(key.toLowerCase());
      return [key, str(value)];
    }),
  );
}
function cidrs(v: any): string[] {
  return list(v).map((raw) => {
    const value = str(raw, 100),
      [ip, bits, ...rest] = value.split("/");
    if (value === "all") return value;
    const family = isIP(ip);
    if (
      !family ||
      rest.length ||
      (bits !== undefined &&
        (!/^\d+$/.test(bits) || Number(bits) > (family === 4 ? 32 : 128)))
    )
      bad("INVALID_NGINX_CIDR");
    return value;
  });
}
/** Scan tokens, comments, quotes and braces rather than trusting substring checks.
 * Fragments stay in the supplied context; dynamic code and external files are not accepted.
 */
export function nginxSnippet(value: any): string {
  if (value === undefined || value === "") return "";
  if (typeof value !== "string" || value.length > 20000 || value.includes("\0"))
    bad("INVALID_NGINX_SNIPPET");
  let depth = 0,
    quote = "",
    comment = false,
    escaped = false,
    token = "",
    start = true;
  const check = () => {
    if (
      start &&
      token &&
      (/^(include|load_module|env|daemon|master_process|pid|user|http|events|stream|server|listen|server_name|ssl_certificate|ssl_certificate_key|root|alias)$/i.test(
        token,
      ) ||
        /lua|perl|^(js_|auth_basic_user_file)/i.test(token))
    )
      bad("NGINX_DIRECTIVE_OUTSIDE_SITE_SCOPE");
    if (token) start = false;
    token = "";
  };
  for (const ch of value) {
    if (comment) {
      if (ch === "\n") comment = false;
      continue;
    }
    if (escaped) {
      token += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = "";
      else token += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "#") {
      check();
      comment = true;
      continue;
    }
    if (/\s/.test(ch)) {
      check();
      continue;
    }
    if (ch === "{" || ch === "}" || ch === ";") {
      check();
      if (ch === "{") depth++;
      if (ch === "}" && --depth < 0) bad("NGINX_SNIPPET_CONTEXT_ESCAPE");
      start = true;
      continue;
    }
    token += ch;
  }
  check();
  if (depth || quote || escaped || !start) bad("INCOMPLETE_NGINX_SNIPPET");
  return value;
}
export function normalizeNginx(value: any = {}): Config {
  const s = obj(value),
    out: Config = {
      body_size_mb: num(s.body_size_mb, 20, 102400),
      keepalive_seconds: num(s.keepalive_seconds, 75),
      gzip: flag(s.gzip, false),
      gzip_level: num(s.gzip_level, 5, 9, 1),
      access_log: flag(s.access_log, true),
      error_log_level: choice(
        s.error_log_level,
        ["debug", "info", "notice", "warn", "error", "crit"],
        "warn",
      ),
      http2: flag(s.http2, false),
      redirect_https: flag(s.redirect_https, false),
      tls_protocols: list(s.tls_protocols ?? ["TLSv1.2", "TLSv1.3"], 2).map(
        (v) => choice(v, ["TLSv1.2", "TLSv1.3"], "TLSv1.3"),
      ),
      response_headers: headers(s.response_headers),
      allow: cidrs(s.allow),
      deny: cidrs(s.deny),
      index: list(s.index ?? ["index.html"], 10).map((v) => {
        const x = str(v, 100);
        return /^[A-Za-z0-9_.-]+$/.test(x) ? x : bad("INVALID_NGINX_INDEX");
      }),
      spa_fallback: flag(s.spa_fallback, false),
      autoindex: flag(s.autoindex, false),
      expires_seconds: num(s.expires_seconds, 0, 31536000),
      server_snippet: nginxSnippet(s.server_snippet),
    };
  if (!out.tls_protocols.length || !out.index.length)
    bad("EMPTY_NGINX_OPTIONS");
  return out;
}
export function normalizeLocations(value: any): Config[] {
  const seen = new Set<string>();
  return list(value, 100).map((raw) => {
    const s = obj(raw),
      match = choice(
        s.match,
        ["prefix", "prefer_prefix", "exact", "regex", "regex_ci"],
        "prefix",
      ),
      path = str(s.path, 1024);
    if (
      !path ||
      (!match.startsWith("regex") &&
        (!path.startsWith("/") || /[?#\s{};$]/.test(path))) ||
      path.includes("/.well-known/lightmoni-") ||
      seen.has(match + ":" + path)
    )
      bad("INVALID_OR_DUPLICATE_LOCATION");
    seen.add(match + ":" + path);
    const out: Config = {
      path,
      match,
      action: choice(s.action, ["proxy", "return"], "proxy"),
      response_headers: headers(s.response_headers),
      allow: cidrs(s.allow),
      deny: cidrs(s.deny),
      custom_config: nginxSnippet(s.custom_config),
      limit_rate_kbps: num(s.limit_rate_kbps, 0, 1048576),
    };
    if (out.action === "return") {
      out.return_status = num(s.return_status, 302, 599, 200);
      if (
        !Number.isInteger(out.return_status) ||
        ![
          200, 201, 204, 301, 302, 303, 307, 308, 400, 401, 403, 404, 410, 429,
          500, 502, 503,
        ].includes(out.return_status)
      )
        bad("INVALID_NGINX_RETURN_STATUS");
      out.return_value = str(s.return_value ?? "");
      return out;
    }
    out.target = choice(s.target, ["upstream", "service"], "upstream");
    if (out.target === "service") out.service_id = str(s.service_id, 100);
    out.upstreams = list(s.upstreams).map((v) => {
      const x = typeof v === "string" ? { url: v } : obj(v);
      let u: URL;
      try {
        u = new URL(x.url);
      } catch {
        return bad("INVALID_WEBSITE_UPSTREAM");
      }
      if (
        !["http:", "https:"].includes(u.protocol) ||
        u.username ||
        u.password ||
        u.pathname !== "/" ||
        u.search ||
        u.hash ||
        !u.hostname ||
        /[\s{};$]/.test(u.host)
      )
        bad("INVALID_WEBSITE_UPSTREAM");
      return {
        url: u.origin,
        weight: num(x.weight, 1, 1000, 1),
        max_fails: num(x.max_fails, 1, 100),
        fail_timeout_seconds: num(x.fail_timeout_seconds, 10),
        backup: flag(x.backup, false),
      };
    });
    if (out.target === "upstream" && !out.upstreams.length && !s.unavailable)
      bad("WEBSITE_UPSTREAM_REQUIRED");
    if (
      new Set(out.upstreams.map((u: Config) => new URL(u.url).protocol)).size >
      1
    )
      bad("MIXED_UPSTREAM_PROTOCOLS");
    out.unavailable = s.unavailable === true;
    out.balance = choice(
      s.balance,
      ["round_robin", "least_conn", "ip_hash"],
      "round_robin",
    );
    if (
      out.balance === "ip_hash" &&
      out.upstreams.some((u: Config) => u.backup)
    )
      bad("IP_HASH_BACKUP_NOT_SUPPORTED");
    out.uri_mode = choice(
      s.uri_mode,
      ["preserve", "strip_prefix", "replace_prefix"],
      "preserve",
    );
    if (match.startsWith("regex") && out.uri_mode !== "preserve")
      bad("REGEX_LOCATION_REQUIRES_PRESERVED_URI");
    if (
      ["prefix", "prefer_prefix"].includes(match) &&
      out.uri_mode !== "preserve" &&
      !path.endsWith("/")
    )
      bad("URI_REPLACEMENT_REQUIRES_TRAILING_SLASH_LOCATION");
    out.uri_prefix = str(s.uri_prefix ?? "/", 1024);
    if (!out.uri_prefix.startsWith("/") || /[\s{};$?#]/.test(out.uri_prefix))
      bad("INVALID_PROXY_URI_PREFIX");
    out.host_header = str(s.host_header ?? "$host", 253);
    out.request_headers = headers(s.request_headers);
    out.hide_headers = list(s.hide_headers).map((v) => {
      const h = str(v, 100);
      headers({ [h]: "" });
      return h;
    });
    for (const [key, fallback] of [
      ["connect_timeout_seconds", 5],
      ["read_timeout_seconds", 60],
      ["send_timeout_seconds", 60],
      ["keepalive", 32],
      ["retry_tries", 0],
    ] as const)
      out[key] = num(s[key], fallback);
    for (const [key, fallback] of [
      ["websocket", true],
      ["buffering", true],
      ["request_buffering", true],
      ["ssl_verify", false],
    ] as const)
      out[key] = flag(s[key], fallback);
    out.ssl_name = str(s.ssl_name ?? "", 253);
    if (s.body_size_mb !== undefined)
      out.body_size_mb = num(s.body_size_mb, 20, 102400);
    out.requests_per_second = num(s.requests_per_second, 0, 100000);
    out.burst = num(s.burst, 0, 100000);
    out.connections = num(s.connections, 0, 100000);
    if (s.cache?.enabled) {
      if (!out.buffering) bad("PROXY_CACHE_REQUIRES_RESPONSE_BUFFERING");
      out.cache = {
        enabled: true,
        ttl_seconds: num(s.cache.ttl_seconds, 60, 31536000, 1),
        max_size_mb: num(s.cache.max_size_mb, 100, 102400, 1),
        stale: flag(s.cache.stale, false),
      };
    }
    out.proxy_redirect = choice(
      s.proxy_redirect,
      ["default", "off"],
      "default",
    );
    if (s.cors?.enabled) {
      const c = obj(s.cors),
        origin = str(c.origin ?? "*", 1000);
      if (c.credentials && origin === "*")
        bad("CORS_CREDENTIALS_REQUIRE_EXPLICIT_ORIGIN");
      out.cors = {
        enabled: true,
        origin,
        credentials: flag(c.credentials, false),
        methods: str(c.methods ?? "GET, POST, PUT, PATCH, DELETE, OPTIONS"),
        headers: str(c.headers ?? "Content-Type, Authorization"),
        max_age: num(c.max_age, 86400),
      };
    }
    return out;
  });
}
const headerLines = (h: Config) =>
  Object.entries(h).map(
    ([key, value]) =>
      `add_header ${nginxQuote(key)} ${nginxQuote(String(value))} always;`,
  );
const mergeHeaders = (...groups: Config[]): Config =>
  Object.fromEntries([
    ...groups
      .reduce((map, group) => {
        for (const [key, value] of Object.entries(group))
          map.set(key.toLowerCase(), [key, value]);
        return map;
      }, new Map<string, [string, any]>())
      .values(),
  ]);
const aclLines = (s: Config) => [
  ...(s.allow ?? []).map((x: string) => `allow ${x};`),
  ...(s.deny ?? []).map((x: string) => `deny ${x};`),
];
export function renderNginxOptions(s: Config): string[] {
  return [
    `client_max_body_size ${s.body_size_mb}m;`,
    `keepalive_timeout ${s.keepalive_seconds}s;`,
    `access_log ${s.access_log ? "/dev/stdout" : "off"};`,
    `error_log /dev/stderr ${s.error_log_level};`,
    `gzip ${s.gzip ? "on" : "off"};`,
    ...(s.gzip
      ? [
          `gzip_comp_level ${s.gzip_level};`,
          "gzip_vary on;",
          "gzip_types text/plain text/css application/json application/javascript application/xml image/svg+xml;",
        ]
      : []),
    ...headerLines(s.response_headers),
    ...aclLines(s),
    s.server_snippet,
  ].filter(Boolean);
}
export function renderLocations(
  raw: any,
  siteID: string,
  settings: Config,
): { upstreams: string[]; locations: string[] } {
  const routes = normalizeLocations(raw),
    upstreams: string[] = [],
    locations: string[] = [];
  routes.forEach((s, index) => {
    const backend = `backend_${siteID}_${index}`,
      modifier = (
        {
          prefix: "",
          prefer_prefix: "^~ ",
          exact: "= ",
          regex: "~ ",
          regex_ci: "~* ",
        } as Config
      )[s.match];
    const lines = [
      `location ${modifier}${nginxQuote(s.path)} {`,
      ...aclLines(s),
    ];
    if (s.requests_per_second) {
      upstreams.push(
        `limit_req_zone $binary_remote_addr zone=req_${siteID}_${index}:1m rate=${s.requests_per_second}r/s;`,
      );
      lines.push(
        `limit_req zone=req_${siteID}_${index}${s.burst ? " burst=" + s.burst : ""} nodelay;`,
        "limit_req_status 429;",
      );
    }
    if (s.connections) {
      upstreams.push(
        `limit_conn_zone $binary_remote_addr zone=conn_${siteID}_${index}:1m;`,
      );
      lines.push(
        `limit_conn conn_${siteID}_${index} ${s.connections};`,
        "limit_conn_status 429;",
      );
    }
    if (s.body_size_mb !== undefined)
      lines.push(`client_max_body_size ${s.body_size_mb}m;`);
    const response = mergeHeaders(
      settings.response_headers,
      s.response_headers,
    );
    if (s.cors)
      Object.assign(response, {
        "Access-Control-Allow-Origin": s.cors.origin,
        "Access-Control-Allow-Methods": s.cors.methods,
        "Access-Control-Allow-Headers": s.cors.headers,
        "Access-Control-Max-Age": s.cors.max_age,
        ...(s.cors.credentials
          ? { "Access-Control-Allow-Credentials": "true" }
          : {}),
      });
    lines.push(...headerLines(response));
    if (s.cors)
      lines.push(
        "if ($request_method = OPTIONS) {",
        ...headerLines(response),
        "return 204;",
        "}",
      );
    if (s.cache) {
      const zone = `cache_${siteID}_${index}`;
      upstreams.push(
        `proxy_cache_path /tmp/lightmoni-${zone} levels=1:2 keys_zone=${zone}:1m max_size=${s.cache.max_size_mb}m inactive=${s.cache.ttl_seconds}s use_temp_path=off;`,
      );
      lines.push(
        `proxy_cache ${zone};`,
        `proxy_cache_valid 200 ${s.cache.ttl_seconds}s;`,
        'proxy_cache_key "$scheme$host$request_method$request_uri";',
        "proxy_cache_bypass $http_authorization $http_cookie $http_upgrade;",
        "proxy_no_cache $http_authorization $http_cookie $http_upgrade;",
        "proxy_cache_lock on;",
        "add_header X-LightMoni-Cache $upstream_cache_status always;",
        ...(s.cache.stale
          ? [
              "proxy_cache_use_stale error timeout updating http_500 http_502 http_503 http_504;",
              "proxy_cache_background_update on;",
            ]
          : []),
      );
    }
    if (s.limit_rate_kbps) lines.push(`limit_rate ${s.limit_rate_kbps}k;`);
    if (s.action === "return")
      lines.push(
        `return ${s.return_status}${s.return_value ? " " + nginxQuote(s.return_value) : ""};`,
      );
    else if (s.unavailable || !s.upstreams.length) lines.push("return 503;");
    else {
      const first = new URL(s.upstreams[0].url);
      upstreams.push(
        `upstream ${backend} {`,
        ...(s.balance !== "round_robin" ? [s.balance + ";"] : []),
        ...s.upstreams.map((u: Config) => {
          const url = new URL(u.url);
          return `server ${url.host}${url.port ? "" : url.protocol === "https:" ? ":443" : ":80"} weight=${u.weight} max_fails=${u.max_fails} fail_timeout=${u.fail_timeout_seconds}s${u.backup ? " backup" : ""};`;
        }),
        ...(s.keepalive ? [`keepalive ${s.keepalive};`] : []),
        "}",
      );
      const uri =
        s.uri_mode === "preserve"
          ? ""
          : s.uri_mode === "strip_prefix"
            ? "/"
            : s.uri_prefix;
      lines.push(
        `proxy_pass ${first.protocol}//${backend}${uri};`,
        "proxy_http_version 1.1;",
      );
      const request = mergeHeaders(
        {
          Host: s.host_header,
          "X-Real-IP": "$remote_addr",
          "X-Forwarded-For": "$proxy_add_x_forwarded_for",
          "X-Forwarded-Proto": "$scheme",
          Connection: s.websocket ? "$lightmoni_connection_upgrade" : "",
          ...(s.websocket ? { Upgrade: "$http_upgrade" } : {}),
        },
        s.request_headers,
      );
      for (const [key, value] of Object.entries(request))
        lines.push(
          `proxy_set_header ${nginxQuote(key)} ${nginxQuote(String(value))};`,
        );
      for (const key of s.hide_headers)
        lines.push(`proxy_hide_header ${nginxQuote(key)};`);
      lines.push(
        `proxy_connect_timeout ${s.connect_timeout_seconds}s;`,
        `proxy_read_timeout ${s.read_timeout_seconds}s;`,
        `proxy_send_timeout ${s.send_timeout_seconds}s;`,
        `proxy_buffering ${s.buffering ? "on" : "off"};`,
        `proxy_request_buffering ${s.request_buffering ? "on" : "off"};`,
        `proxy_redirect ${s.proxy_redirect};`,
        `proxy_next_upstream_tries ${s.retry_tries};`,
        "proxy_ssl_server_name on;",
        `proxy_ssl_name ${nginxQuote(s.ssl_name || first.hostname.replace(/^\[|\]$/g, ""))};`,
        `proxy_ssl_verify ${s.ssl_verify ? "on" : "off"};`,
        ...(s.ssl_verify
          ? [
              "proxy_ssl_trusted_certificate /etc/ssl/certs/ca-certificates.crt;",
            ]
          : []),
      );
    }
    lines.push(s.custom_config, "}");
    locations.push(...lines.filter(Boolean));
  });
  return { upstreams, locations };
}
