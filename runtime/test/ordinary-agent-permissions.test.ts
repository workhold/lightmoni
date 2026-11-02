import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { assertOrdinaryAgentPermissions, assertOrdinaryAgentSocketIsolation, type OrdinaryAgentPermissionSnapshot } from "../src/shared/ordinary-agent-permissions.js";
const ordinary = (): OrdinaryAgentPermissionSnapshot => ({ uid: 991, euid: 991, gid: 991, groups: [991], names: ["lightmoni-agent"], capabilities: { inheritable: "0000000000000000", permitted: "0000000000000000", effective: "0000000000000000", ambient: "0000000000000000" } });

test("ordinary Linux run permits an unprivileged identity and refuses actual root, dangerous groups and every active capability lane", () => {
  assert.doesNotThrow(() => assertOrdinaryAgentPermissions(ordinary()));
  for (const change of [{ uid: 0 }, { euid: 0 }, { gid: 0 }, { groups: [991, 0] }, ...["docker", "lxd", "lxc", "incus-admin", "disk", "kmem", "libvirt", "sudo", "wheel", "root"].map(name => ({ names: ["lightmoni-agent", name] }))])
    assert.throws(() => assertOrdinaryAgentPermissions({ ...ordinary(), ...change }), /ordinary_agent_privilege_violation/);
  for (const capability of ["inheritable", "permitted", "effective", "ambient"] as const) { const snapshot = ordinary(); snapshot.capabilities[capability] = "400"; assert.throws(() => assertOrdinaryAgentPermissions(snapshot), /ordinary_agent_privilege_violation/); }
});

test("missing or malformed actual permission evidence fails closed", () => {
  for (const change of [{ uid: NaN }, { uid: -1 }, { gid: 1.2 }, { groups: [NaN] }, { names: [] }, { names: ["unexpected\nname"] }, { capabilities: {} }, { capabilities: { ...ordinary().capabilities, effective: "not-hex" } }])
    assert.throws(() => assertOrdinaryAgentPermissions({ ...ordinary(), ...change } as OrdinaryAgentPermissionSnapshot));
});

test("the ordinary service grants no Docker group, Linux capability or public website write path", () => {
  const unit = readFileSync(new URL("../../deploy/agent/lightmoni-agent.service", import.meta.url), "utf8");
  assert.match(unit, /^SupplementaryGroups=$/m); assert.match(unit, /^AmbientCapabilities=$/m); assert.match(unit, /^CapabilityBoundingSet=$/m);
  assert.doesNotMatch(unit, /SupplementaryGroups=.+|AmbientCapabilities=.+|CapabilityBoundingSet=.+|ReadWritePaths=.*lightmoni-web/);
  assert.match(unit, /User=lightmoni-agent/); assert.match(unit, /NoNewPrivileges=true/);
});

test("raw Docker socket authority and symlink aliases refuse ordinary execution without changing host objects", async () => {
  const root = mkdtempSync(join(tmpdir(), "lm-ordinary-socket-")), socket = join(root, "docker.sock"), alias = join(root, "alias.sock"), external = join(root, "external");
  const server = createServer();
  try {
    assert.doesNotThrow(() => assertOrdinaryAgentSocketIsolation(socket));
    await new Promise<void>(resolve => server.listen(socket, resolve));
    assert.throws(() => assertOrdinaryAgentSocketIsolation(socket), /ordinary_agent_privilege_violation/);
    writeFileSync(external, "external-authority"); symlinkSync(external, alias);
    assert.throws(() => assertOrdinaryAgentSocketIsolation(alias), /ordinary_agent_privilege_violation/);
    assert.equal(readFileSync(external, "utf8"), "external-authority");
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); }
});
