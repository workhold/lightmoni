import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeWebsiteAuth,
  publicWebsiteSpec,
} from "../src/ops/website-auth.js";
import { renderGateway } from "../src/operations/platform.js";
import { privateRegistryAddress } from "../src/operations/registry-address.js";
test("website credentials are write only; blank retains same user, caller cannot inject a hash", () => {
  const auth = normalizeWebsiteAuth(
    {
      mode: "basic",
      users: [{ username: "builder", password: "long-test-password" }],
    },
    undefined,
  );
  assert.match(auth.users[0].password_hash, /^\$2/);
  const next = normalizeWebsiteAuth(
    { mode: "basic", users: [{ username: "builder", password: "" }] },
    auth,
  );
  assert.equal(next.users[0].password_hash, auth.users[0].password_hash);
  assert.throws(() =>
    normalizeWebsiteAuth(
      { mode: "basic", users: [{ username: "other", password: "" }] },
      auth,
    ),
  );
  assert.throws(
    () => normalizeWebsiteAuth(auth, auth),
    /website_auth_hash_host_owned/,
  );
  const view = JSON.stringify(
    publicWebsiteSpec({ auth, bindings: [{ locations: [{ auth }] }] }),
  );
  assert(!view.includes("password_hash"));
  assert(!view.includes("long-test-password"));
  assert(view.includes("has_password"));
});
test("Basic compiler protects server and paths, strips upstream credentials, rejects rewrite bypasses", () => {
  const auth = normalizeWebsiteAuth(
    {
      mode: "basic",
      users: [{ username: "builder", password: "long-test-password" }],
    },
    undefined,
  );
  const site = {
    id: "a".repeat(32),
    domains: ["registry.example.test"],
    mode: "proxy",
    auth,
    locations: [{ path: "/", upstreams: ["http://127.0.0.1:5000"] }],
  };
  const config = renderGateway({ sites: [site] }, "b".repeat(64), true);
  assert.match(config, /auth_basic_user_file/);
  assert.match(config, /proxy_set_header "Authorization" "";/);
  assert(!config.includes(auth.users[0].password_hash));
  for (const route of [
    { path: "/", action: "return", return_status: 200 },
    {
      path: "/",
      upstreams: ["http://127.0.0.1:5000"],
      cors: { enabled: true },
    },
    {
      path: "/",
      upstreams: ["http://127.0.0.1:5000"],
      cache: { enabled: true },
    },
  ])
    assert.throws(
      () =>
        renderGateway(
          { sites: [{ ...site, locations: [route] }] },
          "b".repeat(64),
          true,
        ),
      /AUTH/,
    );
});
test("anonymous registry endpoints must be literal private addresses", () => {
  for (const ip of [
    "10.4.3.2",
    "192.168.2.1",
    "172.16.0.1",
    "127.0.0.1",
    "fd00::1",
  ])
    assert.equal(privateRegistryAddress(ip), ip);
  for (const ip of [
    "0.0.0.0",
    "::",
    "8.8.8.8",
    "169.254.169.254",
    "registry.internal",
    "172.32.0.1",
  ])
    assert.throws(() => privateRegistryAddress(ip));
});
