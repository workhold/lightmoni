import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { canonicalJSON, parseStrictJSON, sha256, signJWS, verifyJWS, signExecutorRequest, requestClaims, normalizePrivilegedPayload, validatePrivilegedPayload, validatePlan } from "../src/shared/privileged-executor.js";

test("signed raw payloads reject duplicate fields, invalid UTF8, non Ed25519 headers and substituted bytes", () => {
  const key = generateKeyPairSync("ed25519"), value = { z: 3, a: { b: 1 } };
  assert.equal(canonicalJSON(value), '{"a":{"b":1},"z":3}');
  const signed = signJWS(value, key.privateKey, "center");
  assert.deepEqual(JSON.parse(JSON.stringify(verifyJWS(signed, key.publicKey, "center"))), value);
  assert.throws(() => verifyJWS(signed, key.publicKey, "another"), /invalid_signature/);
  const parts = signed.split("."); parts[1] = Buffer.from('{"a":1,"a":2}').toString("base64url");
  parts[2] = sign(null, Buffer.from(parts[0] + "." + parts[1]), key.privateKey).toString("base64url");
  assert.throws(() => verifyJWS(parts.join("."), key.publicKey, "center"), /duplicate/);
  assert.throws(() => parseStrictJSON('{"nested":{"x":1,"\\u0078":2}}'), /duplicate/);
  assert.throws(() => parseStrictJSON(Buffer.from([0x22, 0xff, 0x22])), /encoded|encoding/i);
  assert.throws(() => parseStrictJSON('[1,]'), /invalid_json/);
  assert.throws(() => parseStrictJSON('{"n":1e999}'), /invalid_json_number/);
  parts[0] = Buffer.from('{"alg":"HS256","typ":"lightmoni-executor-v1","kid":"center"}').toString("base64url");
  parts[2] = sign(null, Buffer.from(parts[0] + "." + parts[1]), key.privateKey).toString("base64url");
  assert.throws(() => verifyJWS(parts.join("."), key.publicKey, "center"), /invalid_signature/);
});

test("executor request binds fixed path, raw body, generation and short validity", () => {
  const key = generateKeyPairSync("ed25519"), body = '{"x":1}';
  const input = { center_instance_id: "center", executor_id: "executor-one", install_generation: 1, method: "POST" as const, path: "/api/v1/privileged-executors/executor-one/jobs/claim", body, request_id: "request_1234567890", iat: 1000, exp: 1060 };
  const signed = signExecutorRequest(input, key.privateKey), claims = requestClaims(verifyJWS(signed, key.publicKey, "executor-one"), 1000);
  assert.equal(claims.body_sha256, sha256(body));
  assert.throws(() => requestClaims({ ...claims, exp: 1061 }, 1000), /expired/);
  assert.throws(() => requestClaims({ ...claims, path: input.path + "?other=1" }, 1000), /invalid_request_path/);
  assert.throws(() => requestClaims({ ...claims, unexpected: true }, 1000), /unknown/);
  assert.throws(() => requestClaims(claims, 1121), /expired/);
});

const script = { kind: "script", runtime: "shell", code: "id", interpreter_sha256: "a".repeat(64), args: [], cwd_profile: "private", environment: { SAMPLE: "one" }, account: { name: "root", uid: 0, gid: 0, groups: [0] }, timeout_ms: 5000, max_output_bytes: 4096 };
test("script profile freezes full content and prevents interpreter environment injection", () => {
  const payload = normalizePrivilegedPayload(script); validatePrivilegedPayload(payload);
  assert.equal(payload.kind, "script"); if (payload.kind !== "script") return;
  assert.equal(payload.code_sha256, sha256("id"));
  assert.throws(() => normalizePrivilegedPayload({ ...payload, code: "id; whoami" }), /digest/);
  assert.throws(() => normalizePrivilegedPayload({ ...script, schedule: "cron" }), /unknown/);
  assert.throws(() => normalizePrivilegedPayload({ ...script, environment: { NODE_OPTIONS: "--require=/tmp/evil" } }), /unsafe_environment/);
  assert.throws(() => normalizePrivilegedPayload({ ...script, account: { name: "app", uid: 0, gid: 0, groups: [] } }), /root_account/);
  assert.throws(() => normalizePrivilegedPayload({ ...script, args: ["x\0y"] }), /invalid_text/);
  assert.throws(() => validatePrivilegedPayload(script), /missing_payload_digest/);
});

test("container profile only permits digest-pinned fixed schema without host inputs", () => {
  const create = { kind: "container", operation: "create", resource_id: "workload_one", resource_revision: 1, image: "registry.example.test/app@sha256:" + "a".repeat(64), platform: "linux/amd64", timeout_ms: 30000, max_output_bytes: 4096 };
  assert.equal(normalizePrivilegedPayload(create).kind, "container");
  assert.throws(() => normalizePrivilegedPayload({ ...create, image: "alpine:latest" }), /unsafe/);
  assert.throws(() => normalizePrivilegedPayload({ ...create, mounts: ["/:/host"] }), /unknown/);
  assert.throws(() => normalizePrivilegedPayload({ ...create, command: ["sh"] }), /unknown/);
  assert.throws(() => normalizePrivilegedPayload({ ...create, resource_revision: "1" }), /integer/);
});
