import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeNginx,
  normalizeLocations,
  nginxSnippet,
} from "../src/operations/nginx.js";
import { renderGateway } from "../src/operations/platform.js";
const id = "a".repeat(32);
const gateway = (site: any) =>
  renderGateway(
    {
      http_port: 18080,
      https_port: 18443,
      sites: [{ id, domains: ["routes.example.test"], mode: "proxy", ...site }],
    },
    "preview",
    true,
  );
test("Nginx routes distinguish exact, longest-prefix and ordered regex with explicit URI behavior", () => {
  const config = gateway({
    locations: [
      {
        path: "/api/",
        upstreams: ["http://127.0.0.1:3000"],
        uri_mode: "strip_prefix",
      },
      {
        path: "/legacy/",
        match: "prefer_prefix",
        upstreams: ["http://127.0.0.1:4000"],
        uri_mode: "replace_prefix",
        uri_prefix: "/v2/",
      },
      {
        path: "/login",
        match: "exact",
        action: "return",
        return_status: 302,
        return_value: "https://$host/sign-in",
      },
      {
        path: "\\.(jpg|png)$",
        match: "regex_ci",
        upstreams: ["http://127.0.0.1:5000"],
      },
    ],
  });
  assert.match(config, /location "\/api\/"/);
  assert.match(config, /proxy_pass http:\/\/backend_\w+_0\//);
  assert.match(config, /location \^~ "\/legacy\/"/);
  assert.match(config, /backend_\w+_1\/v2\//);
  assert.match(config, /location = "\/login"/);
  assert.match(config, /return 302 "https:\/\/\$host\/sign-in"/);
  assert.match(config, /location ~\*/);
  assert.match(config, /location \/ \{  return 404;/);
  assert.throws(
    () =>
      normalizeLocations([
        {
          path: "x",
          match: "regex",
          upstreams: ["http://127.0.0.1"],
          uri_mode: "strip_prefix",
        },
      ]),
    /REGEX_LOCATION/,
  );
});
test("Nginx compiler exposes weighted upstreams, SNI, headers, streaming, CORS and site settings", () => {
  const config = gateway({
    nginx: {
      body_size_mb: 128,
      gzip: true,
      response_headers: { "X-Site": "value" },
      server_snippet: "client_body_timeout 30s;",
    },
    locations: [
      {
        path: "/",
        balance: "least_conn",
        upstreams: [
          { url: "https://origin.example.test", weight: 3 },
          { url: "https://backup.example.test", backup: true },
        ],
        host_header: "origin.example.test",
        request_headers: { "X-Request-ID": "$request_id" },
        response_headers: { "X-Route": "api" },
        buffering: false,
        request_buffering: false,
        read_timeout_seconds: 300,
        cors: {
          enabled: true,
          origin: "https://app.example.test",
          credentials: true,
        },
        allow: ["10.0.0.0/8"],
        deny: ["all"],
      },
    ],
  });
  for (const expected of [
    "least_conn;",
    "weight=3",
    " backup;",
    'proxy_ssl_name "origin.example.test"',
    'proxy_set_header "X-Request-ID" "$request_id"',
    "proxy_buffering off;",
    "proxy_request_buffering off;",
    "proxy_read_timeout 300s;",
    "client_max_body_size 128m;",
    "gzip on;",
    "if ($request_method = OPTIONS)",
    "Access-Control-Allow-Credentials",
    "allow 10.0.0.0/8;",
    "deny all;",
    "client_body_timeout 30s;",
  ])
    assert.ok(config.includes(expected), expected);
  assert.equal(
    (config.match(/add_header "X-Site"/g) ?? []).length,
    3,
    "server, location and preflight retain the site header",
  );
  assert.match(config, /map \$http_upgrade \$lightmoni_connection_upgrade/);
  assert.throws(
    () =>
      normalizeLocations([
        {
          path: "/",
          upstreams: ["http://a"],
          cors: { enabled: true, origin: "*", credentials: true },
        },
      ]),
    /CORS_CREDENTIALS/,
  );
});
test("Nginx validation rejects directive injection, protocol ambiguity and reserved proof paths", () => {
  for (const route of [
    { path: "/", upstreams: ["http://a", "https://b"] },
    { path: "/.well-known/lightmoni-health", upstreams: ["http://a"] },
    { path: "/; return 200 x;", upstreams: ["http://a"] },
    { path: "/", upstreams: ["http://user:password@a"] },
    { path: "/", upstreams: ["http://a/path"] },
    {
      path: "/",
      upstreams: ["http://a"],
      request_headers: { "X-Test": "x\r\ny" },
    },
    { path: "/", upstreams: ["http://a"], allow: ["10.0.0.1/99"] },
  ])
    assert.throws(() => normalizeLocations([route]));
  assert.throws(() =>
    normalizeLocations([
      { path: "/", upstreams: ["http://a"] },
      { path: "/", upstreams: ["http://b"] },
    ]),
  );
  assert.throws(() => normalizeNginx({ body_size_mb: 1.5 }));
});
test("Nginx snippets enforce context boundaries including quoted and escaped directive names", () => {
  for (const value of [
    "} server { return 200; }",
    "include /tmp/secret;",
    '"include" /tmp/secret;',
    "in\\clude /tmp/secret;",
    "content_by_lua_block { return 1; }",
    "load_module x;",
    "location / { alias /etc/; }",
    "if ($arg_x) { return 200;",
    'add_header X "unfinished;',
  ])
    assert.throws(() => nginxSnippet(value), undefined, value);
  const value =
    '# include is a comment\nif ($arg_a = "}") { return 403; }\nproxy_cookie_path / /app/;';
  assert.equal(nginxSnippet(value), value);
});
test("static SPA options and HTTPS redirect retain the internal proof and TLS options", () => {
  const config = gateway({
    mode: "static",
    certificate: {},
    nginx: {
      http2: true,
      redirect_https: true,
      spa_fallback: true,
      index: ["app.html"],
      expires_seconds: 3600,
    },
  });
  assert.match(config, /http2 on;/);
  assert.match(config, /ssl_protocols TLSv1.2 TLSv1.3/);
  assert.match(config, /try_files \$uri \$uri\/ \/app.html/);
  assert.match(config, /return 308 https:\/\/\$host:18443\$request_uri/);
  assert.ok(
    config.includes(
      "location = /.well-known/lightmoni-health { allow 127.0.0.1; allow ::1; deny all; default_type text/plain; return 200",
    ),
  );
  assert.ok(
    !config
      .slice(
        config.indexOf("location = /.well-known/lightmoni-health"),
        config.indexOf("ssl_protocols"),
      )
      .includes("return 308"),
  );
});

test("proxy cache and per-IP limits render with authenticated traffic bypass and valid shared zones", () => {
  const config = gateway({
    locations: [
      {
        path: "/",
        upstreams: ["http://127.0.0.1:3000"],
        cache: {
          enabled: true,
          ttl_seconds: 120,
          max_size_mb: 50,
          stale: true,
        },
        requests_per_second: 20,
        burst: 10,
        connections: 30,
        body_size_mb: 5,
      },
    ],
  });
  for (const value of [
    "proxy_cache_path /tmp/",
    "max_size=50m",
    "proxy_cache_valid 200 120s;",
    "proxy_cache_bypass $http_authorization $http_cookie $http_upgrade;",
    "proxy_no_cache $http_authorization $http_cookie $http_upgrade;",
    "rate=20r/s",
    "burst=10 nodelay;",
    "limit_req_status 429;",
    "client_max_body_size 5m;",
    "proxy_cache_use_stale",
  ])
    assert.ok(config.includes(value), value);
  assert.throws(
    () =>
      normalizeLocations([
        {
          path: "/",
          upstreams: ["http://a"],
          cache: { enabled: true },
          buffering: false,
        },
      ]),
    /CACHE_REQUIRES/,
  );
});
