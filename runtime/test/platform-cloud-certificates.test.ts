import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createPrivateKey,
  createPublicKey,
  webcrypto,
  X509Certificate,
} from "node:crypto";
import {
  SubjectAlternativeNameExtension,
  X509CertificateGenerator,
} from "@peculiar/x509";
import { createServer } from "node:http";
import { DB } from "../src/shared/sqlite.js";
import { cipher } from "../src/shared/crypto.js";
import { Router } from "../src/shared/http.js";
import { registerAgentJobs } from "./helpers/domain-jobs.js";
import { OperationsPlatformStore } from "../src/ops/store.js";
import {
  CloudClient,
  CloudError,
  deployCloudCertificate,
  ensureDnsRecords,
  inspectCloudCertificate,
  recordInput,
} from "../src/ops/cloud.js";
import {
  createCertificateController,
  getCertificateMaterial,
  selfSignedCertificate,
  validateCertificate,
  validateCertificateTarget,
} from "../src/ops/certificates.js";
import type { Dependencies } from "../src/shared/types.js";
import type { PlatformOptions } from "../src/ops/types.js";

function setup(
  t: any,
  fetcher: typeof fetch = async () => {
    throw Error("unexpected network");
  },
  controllerOverrides: any = {},
) {
  const db = new DB(":memory:");
  db.exec(
    "CREATE TABLE users(id TEXT PRIMARY KEY,role TEXT,active INTEGER);INSERT INTO users VALUES('admin','admin',1);CREATE TABLE agents(id TEXT PRIMARY KEY);INSERT INTO agents VALUES('node-a')",
  );
  let now = new Date("2026-10-29T02:00:00Z");
  const deps = {
    db,
    router: new Router(),
    ...cipher(Buffer.alloc(32, 6)),
    now: () => now,
    logger: { info() {}, warn() {}, error() {} },
  } as unknown as Dependencies;
  const jobs = registerAgentJobs(deps, { agentCredentials: { has: () => true } as any }),
    store = new OperationsPlatformStore(deps, jobs),
    options: PlatformOptions = {
      store,
      deps,
      dataDir: "/tmp/lightmoni-platform-test",
      fetch: fetcher,
    },
    controller = createCertificateController({
      ...options,
      ...controllerOverrides,
    });
  t.after(async () => {
    await controller.close?.();
    await store.close();
    jobs.close?.();
    db.close();
  });
  return {
    db,
    deps,
    jobs,
    store,
    options,
    controller,
    advance(days: number) {
      now = new Date(now.getTime() + days * 86400000);
    },
  };
}
// Seed the prior multi-domain schema directly to prove existing accounts/orders remain compatible.
function legacyCertificate(f: ReturnType<typeof setup>, name: string, spec: Record<string, any>) {
  const resource=f.store.create('certificate',name,{...spec,domains:[spec.domains[0]]},'admin');
  const valid=validateCertificate(spec,spec),encrypted=f.deps.encrypt(JSON.stringify(valid));
  f.db.run('UPDATE ops_platform_resources SET name=?,spec_cipher=? WHERE id=?',name,encrypted,resource.id);
  f.db.run('UPDATE ops_platform_revisions SET name=?,spec_cipher=? WHERE resource_id=?',name,encrypted,resource.id);
  return f.store.get(resource.id);
}
const json = (body: any) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
function providerFixture(provider: "aliyun" | "tencent") {
  let records: any[] = [
      {
        id: "1",
        name: "mail",
        type: "MX",
        value: "external.mail.test",
        ttl: 600,
        enabled: true,
      },
    ],
    next = 2;
  const calls: { action: string; data: any; headers: Headers; url: string }[] =
    [];
  const fetcher: typeof fetch = async (url, init) => {
    const headers = new Headers(init?.headers),
      data =
        provider === "aliyun"
          ? Object.fromEntries(new URLSearchParams(String(init?.body)))
          : JSON.parse(String(init?.body)),
      action =
        provider === "aliyun" ? data.Action : headers.get("x-tc-action")!;
    calls.push({ action, data, headers, url: String(url) });
    if (["AddDomainRecord", "CreateRecord"].includes(action)) {
      const id = String(next++);
      records.push({
        id,
        name: data.RR ?? data.SubDomain,
        type: data.Type ?? data.RecordType,
        value: data.Value,
        ttl: Number(data.TTL),
        enabled: true,
      });
      return json(
        provider === "aliyun"
          ? { RecordId: id }
          : { Response: { RecordId: Number(id) } },
      );
    }
    if (["DeleteDomainRecord", "DeleteRecord"].includes(action)) {
      records = records.filter((r) => r.id !== String(data.RecordId));
      return json(provider === "aliyun" ? {} : { Response: {} });
    }
    if (["UpdateDomainRecord", "ModifyRecord"].includes(action)) {
      const r = records.find((r) => r.id === String(data.RecordId));
      Object.assign(r, {
        name: data.RR ?? data.SubDomain,
        type: data.Type ?? data.RecordType,
        value: data.Value,
        ttl: Number(data.TTL),
      });
      return json(
        provider === "aliyun"
          ? { RecordId: r.id }
          : { Response: { RecordId: Number(r.id) } },
      );
    }
    if (["SetDomainRecordStatus", "ModifyRecordStatus"].includes(action)) {
      records.find((r) => r.id === String(data.RecordId)).enabled =
        String(data.Status).toLowerCase() === "enable";
      return json(provider === "aliyun" ? {} : { Response: {} });
    }
    if (action === "DescribeDomainRecords")
      return json({
        TotalCount: records.length,
        DomainRecords: {
          Record: records.map((r) => ({
            RecordId: r.id,
            RR: r.name,
            Type: r.type,
            Value: r.value,
            TTL: r.ttl,
            Status: r.enabled ? "ENABLE" : "DISABLE",
          })),
        },
      });
    if (action === "DescribeRecordList")
      return json({
        Response: {
          RecordList: records.map((r) => ({
            RecordId: Number(r.id),
            Name: r.name,
            Type: r.type,
            Value: r.value,
            TTL: r.ttl,
            Status: r.enabled ? "ENABLE" : "DISABLE",
          })),
        },
      });
    throw Error("unexpected " + action);
  };
  return {
    fetcher,
    calls,
    get records() {
      return records;
    },
  };
}

for (const provider of ["aliyun", "tencent"] as const)
  test(
    provider +
      " DNS CRUD executes signed fixed endpoints and preserves user records",
    async (t) => {
      const api = providerFixture(provider),
        f = setup(t, api.fetcher),
        credential = f.store.create(
          "credential",
          "DNS",
          {
            provider,
            access_key_id: "test-id",
            access_key_secret: "private-api-secret",
          },
          "admin",
        ),
        zone = f.store.create(
          "dns_zone",
          "Zone",
          { domain: "example.test", credential_id: credential.id },
          "admin",
        );
      await ensureDnsRecords(
        f.options,
        zone.id,
        "website-one",
        [{ name: "www", type: "A", value: "192.0.2.11" }],
        "admin",
      );
      assert.equal(api.records.length, 2);
      assert.equal(api.records[0].value, "external.mail.test");
      await ensureDnsRecords(
        f.options,
        zone.id,
        "website-one",
        [{ name: "www", type: "A", value: "192.0.2.11" }],
        "admin",
      );
      assert.equal(
        api.calls.filter(
          (c) => c.action === "AddDomainRecord" || c.action === "CreateRecord",
        ).length,
        1,
      );
      await ensureDnsRecords(f.options, zone.id, "website-one", [], "admin");
      assert.equal(api.records.length, 1);
      assert.equal(api.records[0].id, "1");
      const input = {
        record: { name: "api", type: "A", value: "192.0.2.12", ttl: 600 },
      };
      const run = await f.controller.perform(
        zone,
        "create_record",
        input,
        "admin",
      );
      assert.equal(run.state, "succeeded");
      assert.equal(run.result.verified, true);
      const audit = JSON.parse(
        f.deps.decrypt(
          f.db.get<any>(
            "SELECT payload_cipher FROM ops_platform_runs WHERE id=?",
            run.id,
          )!.payload_cipher,
        ),
      );
      assert.equal(audit.input.record.name, "api");
      assert.equal(audit.input.record.value, "192.0.2.12");
      assert.equal(audit.resource_snapshot.revision, zone.revision);
      const record = api.records.find((r) => r.name === "api");
      assert.ok(record);
      await f.controller.perform(
        zone,
        "update_record",
        { record: { ...record, value: "192.0.2.13" } },
        "admin",
      );
      assert.equal(
        api.records.find((r) => r.id === record.id)?.value,
        "192.0.2.13",
      );
      await f.controller.perform(
        zone,
        "set_record_status",
        { id: record.id, enabled: false },
        "admin",
      );
      assert.equal(api.records.find((r) => r.id === record.id)?.enabled, false);
      await f.controller.perform(
        zone,
        "delete_record",
        { id: record.id },
        "admin",
      );
      assert.equal(api.records.length, 1);
      for (const call of api.calls) {
        assert.ok(
          call.url.startsWith(
            provider === "aliyun"
              ? "https://alidns.aliyuncs.com/"
              : "https://dnspod.tencentcloudapi.com/",
          ),
        );
        assert.equal(call.url.includes("private-api-secret"), false);
        if (provider === "aliyun") assert.ok(call.data.Signature);
        else
          assert.match(
            call.headers.get("authorization")!,
            /^TC3-HMAC-SHA256 Credential=test-id\//,
          );
      }
      assert.equal(
        JSON.stringify(f.store.public(credential)).includes(
          "private-api-secret",
        ),
        false,
      );
    },
  );

test("DNS scopes include challenge labels, reject outside writes, and stop when authorization is revoked", async (t) => {
  const api = providerFixture("tencent"),
    f = setup(t, api.fetcher),
    cred = f.store.create(
      "credential",
      "DNS",
      { provider: "tencent", access_key_id: "id", access_key_secret: "secret" },
      "admin",
    ),
    zone = f.store.create(
      "dns_zone",
      "Zone",
      {
        domain: "example.test",
        scope: "dev.example.test",
        credential_id: cred.id,
      },
      "admin",
    );
  assert.equal(
    recordInput(zone, {
      name: "_acme-challenge.dev.example.test",
      type: "TXT",
      value: "challenge",
    }).name,
    "_acme-challenge.dev",
  );
  assert.throws(
    () => recordInput(zone, { name: "www", type: "A", value: "192.0.2.1" }),
    /outside_scope/,
  );
  f.db.run("UPDATE users SET active=0 WHERE id='admin'");
  await assert.rejects(
    ensureDnsRecords(
      f.options,
      zone.id,
      "site",
      [{ name: "dev", type: "A", value: "192.0.2.1" }],
      "admin",
    ),
    /authorization_revoked/,
  );
  assert.equal(api.calls.length, 0);
});

test("a timed out DNS create is journalled unknown and never automatically replayed", async (t) => {
  const api = providerFixture("aliyun");
  let writes = 0;
  const f = setup(t, async (url, init) => {
      const action = new URLSearchParams(String(init?.body)).get("Action");
      if (action === "AddDomainRecord") {
        writes++;
        throw Error("timeout containing secret");
      }
      return api.fetcher(url, init);
    }),
    cred = f.store.create(
      "credential",
      "DNS",
      { provider: "aliyun", access_key_id: "id", access_key_secret: "secret" },
      "admin",
    ),
    zone = f.store.create(
      "dns_zone",
      "Zone",
      { domain: "example.test", credential_id: cred.id },
      "admin",
    );
  await assert.rejects(
    ensureDnsRecords(
      f.options,
      zone.id,
      "site",
      [{ name: "www", type: "A", value: "192.0.2.1" }],
      "admin",
    ),
    (e: any) => e.state === "unknown",
  );
  await assert.rejects(
    ensureDnsRecords(
      f.options,
      zone.id,
      "site",
      [{ name: "www", type: "A", value: "192.0.2.1" }],
      "admin",
    ),
    /ownership_unknown/,
  );
  assert.equal(writes, 1);
  assert.equal(
    f.db.get<any>("SELECT state FROM ops_dns_owned")?.state,
    "unknown",
  );
});

test("self signed lifecycle encrypts versions, deduplicates target delivery, rotates and exposes expiry", async (t) => {
  const f = setup(t),
    cert = f.store.create(
      "certificate",
      "Certificate",
      {
        source: "self_signed",
        domains: ["*.example.test"],
        validity_days: 90,
        auto_renew: true,
      },
      "admin",
    ),
    target = f.store.create(
      "certificate_target",
      "Files",
      {
        certificate_id: cert.id,
        type: "directory",
        agent_id: "node-a",
        path: "/etc/example/tls",
        enabled: true,
      },
      "admin",
    );
  const issued = await f.controller.perform(cert, "issue", {}, "admin");
  assert.equal(issued.state, "succeeded");
  assert.ok(issued.result.fingerprint_sha256);
  const material = getCertificateMaterial(f.store, cert.id),
    x509 = new X509Certificate(material.certificate_pem);
  assert.ok(x509.checkHost("www.example.test"));
  assert.ok(
    x509.checkPrivateKey(
      (await import("node:crypto")).createPrivateKey(material.private_key_pem),
    ),
  );
  assert.equal(
    JSON.stringify(f.db.all("SELECT * FROM ops_certificate_versions")).includes(
      "BEGIN",
    ),
    false,
  );
  assert.equal(
    JSON.stringify(f.store.public(f.store.get(cert.id))).includes("BEGIN"),
    false,
  );
  await f.controller.tick?.();
  await f.controller.tick?.();
  assert.equal(f.store.actions(target.id).length, 1);
  const run = f.store.actions(target.id)[0],
    job = f.jobs.claim("node-a", ["operations.platform"])!;
  const config = f.store.resolvePayload(job).resource.config;
  assert.equal(config.task, "certificate.install");
  assert.equal(config.certificate_version, material.certificate_version);
  for (const [i, phase] of [
    "accepted",
    "staging",
    "activating",
    "verifying",
  ].entries())
    f.jobs.event("node-a", job.id, {
      lease_id: job.lease_id,
      sequence: i + 1,
      phase,
      summary: "step",
    });
  f.jobs.result("node-a", job.id, {
    lease_id: job.lease_id,
    state: "succeeded",
    snapshot: {
      health: { healthy: true },
      operations: {
        operation_id: run.id,
        resource_id: target.id,
        data: {
          fingerprint_sha256: material.fingerprint_sha256,
          certificate_version: material.certificate_version,
        },
      },
    },
  });
  assert.equal(
    f.store.get(target.id).status.applied_certificate_version,
    material.certificate_version,
  );
  f.advance(62);
  await f.controller.tick?.();
  for(let attempt=0;attempt<100&&f.store.get(cert.id).status.state==='issuing';attempt++) await new Promise(resolve=>setTimeout(resolve,10));
  const renewed = getCertificateMaterial(f.store, cert.id);
  assert.notEqual(renewed.certificate_version, material.certificate_version);
  assert.equal(f.store.actions(target.id).length, 2);
  f.db.run("UPDATE users SET role='member' WHERE id='admin'");
  f.advance(100);
  await f.controller.tick?.();
  assert.equal(f.store.get(cert.id).status.expired, true);
  assert.equal(f.store.get(cert.id).status.expiry_warning, true);
  assert.equal(
    getCertificateMaterial(f.store, cert.id).certificate_version,
    renewed.certificate_version,
  );
});

test("uploaded material is preserved through blank controls and never auto renewed", async (t) => {
  const f = setup(t),
    material = await selfSignedCertificate(
      ["upload.example.test"],
      4,
      f.deps.now(),
    ),
    spec = validateCertificate({
      source: "uploaded",
      domains: ["upload.example.test"],
      auto_renew: true,
      ...material,
    });
  assert.equal(spec.auto_renew, false);
  const updated = validateCertificate(
    { ...spec, certificate_pem: "", private_key_pem: "" },
    spec,
  );
  assert.equal(updated.private_key_pem, material.private_key_pem);
  const cert = f.store.create("certificate", "Upload", spec, "admin");
  await f.controller.perform(cert, "issue", {}, "admin");
  f.advance(5);
  await f.controller.tick?.();
  assert.equal(f.store.get(cert.id).status.expired, true);
  assert.equal(f.store.get(cert.id).status.renewal_due, false);
  assert.equal(f.db.all("SELECT * FROM ops_certificate_versions").length, 1);
});

test("hook secret environment is encrypted and new certificate versions trigger one authorized job", async (t) => {
  const f = setup(t),
    cert = f.store.create(
      "certificate",
      "Certificate",
      { source: "self_signed", domains: ["example.test"] },
      "admin",
    ),
    hook = f.store.create(
      "certificate_target",
      "Hook",
      {
        certificate_id: cert.id,
        type: "hook",
        agent_id: "node-a",
        enabled: true,
        script: "printf hello",
        env: { CUSTOM_TOKEN: "private-hook-token" },
      },
      "admin",
    );
  assert.equal(
    JSON.stringify(f.store.public(hook)).includes("private-hook-token"),
    false,
  );
  assert.equal(f.store.public(hook).spec.script, undefined);
  assert.equal(f.store.public(hook).spec.has_script, true);
  assert.equal(
    validateCertificateTarget({ ...hook.spec, script: "" }, hook.spec).script,
    "printf hello",
  );
  await f.controller.perform(cert, "issue", {}, "admin");
  await f.controller.tick?.();
  await f.controller.tick?.();
  assert.equal(f.store.actions(hook.id).length, 1);
  const job = f.jobs.claim("node-a", ["operations.platform"])!,
    config = f.store.resolvePayload(job).resource.config;
  assert.equal(config.task, "hook.run");
  assert.equal(config.env.CUSTOM_TOKEN, "private-hook-token");
  assert.ok(config.certificate.private_key_pem.includes("BEGIN"));
  assert.equal(
    JSON.stringify(f.db.all("SELECT * FROM ops_platform_runs")).includes(
      "private-hook-token",
    ),
    false,
  );
  assert.throws(
    () =>
      validateCertificateTarget({
        ...hook.spec,
        env: { LD_PRELOAD: "/tmp/evil" },
      }),
    /environment_key/,
  );
});

for (const provider of ["aliyun", "tencent", "volcengine"] as const)
  test(
    provider + " CDN uploads, binds and reads back the real API schema",
    async (t) => {
      const calls: {
          url: string;
          headers: Headers;
          action: string;
          data: any;
        }[] = [],
        deployed = new Map<string, string>();
      let material: any;
      const fetcher: typeof fetch = async (url, init) => {
        const headers = new Headers(init?.headers),
          u = new URL(String(url)),
          data =
            provider === "aliyun"
              ? Object.fromEntries(new URLSearchParams(String(init?.body)))
              : JSON.parse(String(init?.body)),
          action =
            provider === "aliyun"
              ? data.Action
              : provider === "tencent"
                ? headers.get("x-tc-action")!
                : u.searchParams.get("Action")!;
        calls.push({ url: String(url), headers, action, data });
        if (action === "UploadCertificate")
          return json({ Response: { CertificateId: "remote-cert" } });
        if (action === "AddCertificate")
          return json({
            ResponseMetadata: { RequestId: "volc-req" },
            Result: { CertId: "remote-cert" },
          });
        if (action === "SetCdnDomainSSLCertificate") {
          deployed.set(data.DomainName, "remote-cert");
          return json({ RequestId: "ali-req" });
        }
        if (action === "ModifyDomainConfig") {
          assert.equal(data.Route, "Https.CertInfo.CertId");
          assert.deepEqual(JSON.parse(data.Value), { update: "remote-cert" });
          deployed.set(data.Domain, "remote-cert");
          return json({ Response: { RequestId: "tc-req" } });
        }
        if (action === "BatchDeployCert") {
          deployed.set(data.Domain, "remote-cert");
          return json({
            ResponseMetadata: { RequestId: "volc-req" },
            Result: {
              DeployResult: [{ Domain: data.Domain, Status: "success" }],
            },
          });
        }
        if (action === "DescribeDomainCertificateInfo")
          return json({
            CertInfos: {
              CertInfo: [
                {
                  DomainName: data.DomainName,
                  ServerCertificateStatus: "on",
                  CertId: deployed.get(data.DomainName) ?? "",
                  ServerCertificate: deployed.has(data.DomainName)
                    ? material.certificate_pem
                    : "",
                },
              ],
            },
          });
        if (action === "DescribeDomainsConfig") {
          const domain = data.Filters[0].Value[0];
          return json({
            Response: {
              Domains: [
                {
                  Domain: domain,
                  Https: {
                    Switch: "on",
                    SslStatus: "deployed",
                    Hsts: { Switch: "on" },
                    CertInfo: { CertId: deployed.get(domain) ?? "old-cert" },
                  },
                },
              ],
            },
          });
        }
        if (action === "DescribeCdnConfig")
          return json({
            ResponseMetadata: { RequestId: "volc-req" },
            Result: {
              DomainConfig: {
                HTTPS: {
                  Switch: true,
                  CertInfo: { CertId: deployed.get(data.Domain) ?? "old-cert" },
                },
              },
            },
          });
        throw Error("unexpected " + action);
      };
      const f = setup(t, fetcher),
        cred = f.store.create(
          "credential",
          "Cloud",
          {
            provider,
            access_key_id: "fake-id",
            access_key_secret: "private-cloud-secret",
          },
          "admin",
        ),
        cert = f.store.create(
          "certificate",
          "Certificate",
          { source: "self_signed", domains: ["cdn.example.test"] },
          "admin",
        );
      await f.controller.perform(cert, "issue", {}, "admin");
      material = getCertificateMaterial(f.store, cert.id);
      const target = f.store.create(
        "certificate_target",
        "CDN",
        {
          certificate_id: cert.id,
          type: "cloud",
          provider,
          product: "cdn",
          credential_id: cred.id,
          domains: ["cdn.example.test"],
        },
        "admin",
      );
      const result = await deployCloudCertificate(
        f.options,
        target,
        material,
        "admin",
      );
      assert.equal(result.verified, true);
      await deployCloudCertificate(f.options, target, material, "admin");
      assert.equal(
        calls.filter((c) =>
          [
            "SetCdnDomainSSLCertificate",
            "ModifyDomainConfig",
            "BatchDeployCert",
          ].includes(c.action),
        ).length,
        1,
      );
      assert.equal(
        calls.filter((c) =>
          ["UploadCertificate", "AddCertificate"].includes(c.action),
        ).length,
        provider === "aliyun" ? 0 : 1,
      );
      for (const c of calls) {
        assert.equal(c.url.includes("private-cloud-secret"), false);
        if (provider === "volcengine")
          assert.match(
            c.headers.get("authorization")!,
            /\/cn-north-1\/CDN\/request/,
          );
      }
      if (provider === "volcengine") {
        const uploaded = calls.find((c) => c.action === "AddCertificate")!;
        assert.equal(uploaded.data.Source, "volc_cert_center");
        assert.ok(uploaded.data.Certificate.includes("\r\n"));
      }
    },
  );

test("cloud errors strip echoed secrets and ambiguous writes remain unknown", async () => {
  const credential = {
    provider: "tencent" as const,
    access_key_id: "id",
    access_key_secret: "secret",
  };
  const client = new CloudClient(credential, async () =>
    json({
      Response: {
        Error: {
          Code: "AuthFailure.SecretIdNotFound",
          Message: "private material",
        },
      },
    }),
  );
  await assert.rejects(
    client.request(
      "tencent",
      "ssl",
      "UploadCertificate",
      "2019-12-05",
      {},
      true,
    ),
    (e: any) =>
      e instanceof CloudError &&
      e.code === "AuthFailure.SecretIdNotFound" &&
      !String(e).includes("private material"),
  );
  const timed = new CloudClient(credential, async () => {
    throw Error("private connection detail");
  });
  await assert.rejects(
    timed.request(
      "tencent",
      "ssl",
      "UploadCertificate",
      "2019-12-05",
      {},
      true,
    ),
    (e: any) => e.state === "unknown",
  );
});

test("ACME challenge errors keep the actual problem and phase even when DNS cleanup also fails",async t=>{
  const api=providerFixture('aliyun');let failCleanup=false;
  const f=setup(t,async(url,init)=>{
    if(failCleanup&&new URLSearchParams(String(init?.body)).get('Action')==='DeleteDomainRecord')
      return json({Code:'CleanupDenied',RequestId:'dns-cleanup-request'});
    return api.fetcher(url,init);
  },{resolveChallenge:async()=>true,acmeClientFactory:()=>({
    createAccount:async()=>({}),getAccountUrl:()=> 'https://ca.example.test/account/one',
    createOrder:async()=>({url:'https://ca.example.test/order/one',status:'pending'}),
    getOrder:async()=>({url:'https://ca.example.test/order/one',status:'pending'}),
    getAuthorizations:async()=>[{url:'https://ca.example.test/auth/one',identifier:{value:'example.test'},status:'pending',challenges:[{type:'dns-01',token:'qa-challenge-secret-053'}]}],
    getChallengeKeyAuthorization:async()=> 'qa-txt-secret-053',completeChallenge:async()=>({}),
    waitForValidStatus:async()=>{failCleanup=true;throw Object.assign(new Error('ignored raw response'),{response:{status:400,data:{error:{type:'urn:ietf:params:acme:error:dns',detail:'DNS problem: NXDOMAIN looking up TXT for _acme-challenge.example.test; qa-txt-secret-053'},private_key_pem:'never-copy-response'}}});},
  })});
  const cred=f.store.create('credential','DNS',{provider:'aliyun',access_key_id:'qa-id-053',access_key_secret:'qa-secret-053'},'admin');
  const zone=f.store.create('dns_zone','Zone',{domain:'example.test',credential_id:cred.id},'admin');
  const account=f.store.create('acme_account','ACME',{email:'ops@example.test',directory_url:'letsencrypt-staging',terms_agreed:true},'admin');
  const cert=f.store.create('certificate','Certificate',{source:'acme',domains:['example.test'],acme_account_id:account.id,dns_zone_ids:[zone.id]},'admin');
  const run=await f.controller.perform(cert,'issue',{},'admin');
  assert.equal(run.state,'failed');assert.equal(run.result.phase,'challenge_verify');
  assert.match(run.result.message,/NXDOMAIN/);assert.equal(run.result.error_type,'urn:ietf:params:acme:error:dns');assert.equal(run.result.http_status,400);
  const events=f.store.runEvents(run.id);
  assert(events.some(e=>e.phase==='dns_cleanup'&&e.state==='failed'&&e.code==='CleanupDenied'));
  assert.doesNotMatch(JSON.stringify({run,events,status:f.store.get(cert.id).status}),/qa-txt-secret-053|qa-challenge-secret-053|never-copy-response|BEGIN/);
  assert.equal(f.store.get(cert.id).status.challenge_cleanup,'pending');
  assert.equal(f.store.get(cert.id).status.last_error_phase,'challenge_verify');
});
test("a revoked administrator cannot start a queued certificate network action",async t=>{
  let calls=0;const f=setup(t,undefined,{acmeClientFactory:()=>{calls++;throw Error('network must not start')}});
  const cert=f.store.create('certificate','Revoked',{source:'self_signed',domains:['example.test']},'admin');
  const run=f.controller.startIssue(cert,'issue','admin');
  f.db.run("UPDATE users SET active=0 WHERE id='admin'");
  for(let attempt=0;attempt<100&&f.store.action(run.id).state==='running';attempt++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(f.store.action(run.id).state,'failed');assert.equal(f.store.action(run.id).result.code,'operations_authorization_revoked');assert.equal(calls,0);
});
test("a saved initial issuance intent survives restart and runs once with auto renewal disabled",async t=>{
  const f=setup(t),cert=f.store.create('certificate','Saved before dispatch',{source:'self_signed',domains:['example.test'],auto_renew:false},'admin');
  assert.equal(f.store.get(cert.id).status.initial_issue_pending,true);
  await f.controller.close?.();await f.store.close();
  const store=new OperationsPlatformStore(f.deps,f.jobs),controller=createCertificateController({...f.options,store});
  try {
    await controller.tick?.();
    for(let attempt=0;attempt<100&&store.get(cert.id).status.state==='issuing';attempt++)await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(store.get(cert.id).status.state,'issued');assert.equal(store.get(cert.id).status.initial_issue_pending,false);
    await controller.tick?.();assert.equal(store.actions(cert.id).length,1);
    assert(store.runEvents(store.actions(cert.id)[0].id).some(e=>e.phase==='certificate_save'&&e.state==='succeeded'));
  }finally{await controller.close?.();await store.close();}
});
test("internal certificate callers await and share an active background execution",async t=>{
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve});
  const f=setup(t,undefined,{acmeClientFactory:()=>({createAccount:async()=>{await gate;throw Error('CA contact rejected')}})});
  const cred=f.store.create('credential','DNS',{provider:'aliyun',access_key_id:'qa-id',access_key_secret:'qa-secret'},'admin');
  const zone=f.store.create('dns_zone','Zone',{domain:'example.test',credential_id:cred.id},'admin');
  const account=f.store.create('acme_account','ACME',{email:'ops@example.test',directory_url:'letsencrypt-staging',terms_agreed:true},'admin');
  const cert=f.store.create('certificate','Shared',{source:'acme',domains:['example.test'],acme_account_id:account.id,dns_zone_ids:[zone.id]},'admin');
  try {
    const first=f.controller.startIssue(cert,'issue','admin');let done=false;
    const waiting=f.controller.perform(f.store.get(cert.id),'issue',{},'admin').then(run=>{done=true;return run});
    await new Promise(resolve=>setTimeout(resolve,20));assert.equal(done,false);assert.equal(f.store.actions(cert.id).length,1);
    release();const result=await waiting;assert.equal(result.id,first.id);assert.equal(result.state,'failed');assert.match(result.result.message,/CA contact rejected/);
  }finally{release();}
});
test("an invalid ACME order retains its problem detail and is retired before a manual new order",async t=>{
  const f=setup(t,undefined,{acmeClientFactory:()=>({createAccount:async()=>({}),getAccountUrl:()=> 'https://ca.example.test/account/one',createOrder:async()=>({url:'https://ca.example.test/order/one'}),getOrder:async()=>({status:'invalid',error:{type:'urn:ietf:params:acme:error:rejectedIdentifier',detail:'CA policy rejects example.test'}})})});
  const cred=f.store.create('credential','DNS',{provider:'aliyun',access_key_id:'qa-id',access_key_secret:'qa-secret'},'admin');
  const zone=f.store.create('dns_zone','Zone',{domain:'example.test',credential_id:cred.id},'admin');
  const account=f.store.create('acme_account','ACME',{email:'ops@example.test',directory_url:'letsencrypt-staging',terms_agreed:true},'admin');
  const cert=f.store.create('certificate','Invalid order',{source:'acme',domains:['example.test'],acme_account_id:account.id,dns_zone_ids:[zone.id]},'admin');
  const run=await f.controller.perform(cert,'issue',{},'admin');
  assert.equal(run.state,'failed');assert.equal(run.result.code,'acme_order_invalid');assert.equal(run.result.phase,'get_order');assert.match(run.result.message,/CA policy rejects/);
  assert.equal(run.result.error_type,'urn:ietf:params:acme:error:rejectedIdentifier');assert.equal(f.db.get<any>('SELECT state FROM ops_acme_orders')!.state,'invalid');
  assert.deepEqual(f.store.runEvents(run.id).filter(event=>event.phase==='get_order').map(event=>event.state),['running','failed']);
});

function invalidOrderFixture(t: any, overrides: Record<string, any> = {}, names = ['example.test']) {
  let created = 0;
  const f = setup(t, undefined, {acmeClientFactory:()=>({
    createAccount:async()=>({}),getAccountUrl:()=> 'https://ca.example.test/account/invalid',
    createOrder:async()=>({url:'https://ca.example.test/order/new-'+(++created),status:'pending'}),
    getOrder:async(order:any)=>({...order,status:'invalid',authorizations:['https://ca.example.test/auth/invalid']}),
    getAuthorizations:async()=>[],...overrides,
  })});
  const cred=f.store.create('credential','DNS',{provider:'aliyun',access_key_id:'invalid-order-key-id',access_key_secret:'invalid-order-key-secret'},'admin');
  const zone=f.store.create('dns_zone','Zone',{domain:'example.test',credential_id:cred.id},'admin');
  const account=f.store.create('acme_account','ACME',{email:'ops@example.test',directory_url:'letsencrypt-staging',terms_agreed:true},'admin');
  const cert=names.length>1?legacyCertificate(f,'Invalid authorization',{source:'acme',domains:names,acme_account_id:account.id,dns_zone_ids:[zone.id]}):f.store.create('certificate','Invalid authorization',{source:'acme',domains:names,acme_account_id:account.id,dns_zone_ids:[zone.id]},'admin');
  f.db.run('INSERT INTO ops_acme_orders VALUES(?,?,?,?,?,?,?,?)','cached-invalid-order',cert.id,cert.revision,account.id,'pending',f.deps.encrypt(JSON.stringify({private_key_pem:'cached-private-key-secret',csr:'cached-csr-secret',order:{url:'https://ca.example.test/order/cached'}})),f.deps.now().toISOString(),f.deps.now().toISOString());
  return {...f,cert,created:()=>created,issue:()=>f.controller.perform(f.store.get(cert.id),'issue',{},'admin')};
}

test('cached invalid orders recover DNS challenge reasons, redact TXT and tokens, and require a separate manual new order',async t=>{
  let f:ReturnType<typeof invalidOrderFixture>,lookups=0;
  f=invalidOrderFixture(t,{getAuthorizations:async()=>{
    lookups++;assert.equal(f.db.get<any>('SELECT state FROM ops_acme_orders WHERE id=?','cached-invalid-order')!.state,'invalid');
    return [{identifier:{value:'example.test'},status:'invalid',challenges:[{type:'dns-01',status:'invalid',token:'hidden-invalid-challenge-token',error:{type:'urn:ietf:params:acme:error:dns',status:400,detail:'DNS problem: NXDOMAIN for _acme-challenge.example.test; Incorrect TXT record "hidden-wrong-txt-value" found; hidden-invalid-challenge-token; https://ca.example.test/details?nonce=hidden-url-query',raw_response:'never-publish-authorizations'}}]}];
  }});
  const run=await f.issue(),events=f.store.runEvents(run.id);
  assert.equal(run.state,'failed');assert.equal(run.result.code,'acme_order_invalid');assert.equal(run.result.phase,'get_order');
  assert.match(run.result.message,/NXDOMAIN/);assert.equal(run.result.domain,'example.test');assert.equal(run.result.http_status,400);assert.equal(run.result.error_type,'urn:ietf:params:acme:error:dns');
  assert.deepEqual(events.filter(event=>event.phase==='get_order').map(event=>event.state),['running','failed']);
  assert.deepEqual(events.filter(event=>event.phase==='resume_order').map(event=>event.state),['running','succeeded']);
  assert.equal(f.created(),0);assert.equal(lookups,1);
  assert.doesNotMatch(JSON.stringify({run,events,status:f.store.get(f.cert.id).status}),/hidden-invalid-challenge-token|hidden-wrong-txt-value|hidden-url-query|never-publish-authorizations|cached-private-key-secret|cached-csr-secret|invalid-order-key-secret/);
  const retry=await f.issue();assert.notEqual(retry.id,run.id);assert.equal(f.created(),1);assert.equal(f.db.get<any>('SELECT COUNT(*) n FROM ops_acme_orders')!.n,2);
});

test('order subproblems retain bounded domain-specific reasons without requesting authorizations or exposing raw fields',async t=>{
  let lookups=0;
  const f=invalidOrderFixture(t,{getOrder:async()=>({status:'invalid',error:{type:'urn:ietf:params:acme:error:compound',subproblems:[
    {identifier:{value:'example.test'},type:'urn:ietf:params:acme:error:caa',status:400,detail:'CAA policy rejects example.test',private_key:'never-publish-order'},
    {identifier:{value:'other.example.test'},type:'urn:ietf:params:acme:error:dns',detail:'DNS lookup timed out for other.example.test'},
  ]}}),getAuthorizations:async()=>{lookups++;throw Error('unnecessary authorization request')}} ,['example.test','other.example.test']);
  const run=await f.issue();assert.equal(run.result.domain,'example.test');assert.equal(run.result.error_type,'urn:ietf:params:acme:error:caa');assert.equal(run.result.http_status,400);
  assert.match(run.result.message,/CAA policy rejects/);assert.match(run.result.message,/other.example.test: DNS lookup timed out/);assert.doesNotMatch(JSON.stringify({run,events:f.store.runEvents(run.id)}),/never-publish-order/);assert.equal(lookups,0);assert.equal(f.created(),0);
});

for(const unavailable of [false,true])test('invalid order remains the primary failure when authorization reasons are '+(unavailable?'unavailable':'absent'),async t=>{
  const f=invalidOrderFixture(t,{getAuthorizations:async()=>{if(unavailable)throw Object.assign(Error('authorization expired token=invalid-order-key-secret'),{code:'ca_authorization_gone'});return [{identifier:{value:'example.test'},status:'expired',challenges:[]}];}});
  const run=await f.issue();assert.equal(run.state,'failed');assert.equal(run.result.code,'acme_order_invalid');assert.equal(run.result.phase,'get_order');
  assert.match(run.result.message,unavailable?/could not be read/:/did not provide/);assert.match(run.result.message,/retired/);assert.doesNotMatch(run.result.message,/NXDOMAIN|DNS problem/);
  assert.equal(f.db.get<any>('SELECT state FROM ops_acme_orders')!.state,'invalid');assert.equal(f.created(),0);
  assert.doesNotMatch(JSON.stringify({run,events:f.store.runEvents(run.id)}),/invalid-order-key-secret/);
  if(unavailable)assert(f.store.runEvents(run.id).some(event=>event.phase==='get_authorizations'&&event.state==='failed'&&event.code==='ca_authorization_gone'));
});

test('authorization diagnostic reads recheck the actor and do not run after revocation',async t=>{
  let calls=0,f:ReturnType<typeof invalidOrderFixture>;
  f=invalidOrderFixture(t,{getOrder:async()=>{f.db.run("UPDATE users SET active=0 WHERE id='admin'");return {status:'invalid',authorizations:['https://ca.example.test/auth/one']};},getAuthorizations:async()=>{calls++;return []}});
  const run=await f.issue();assert.equal(run.result.code,'acme_order_invalid');assert.equal(calls,0);
  assert(f.store.runEvents(run.id).some(event=>event.phase==='get_authorizations'&&event.code==='operations_authorization_revoked'));
});

test('problem diagnostics redact before truncation and ignore identifiers outside the configured certificate domains',async t=>{
  const f=invalidOrderFixture(t,{getOrder:async()=>({status:'invalid',error:{subproblems:[{identifier:{value:'invalid-order-key-secret'},type:'urn:ietf:params:acme:error:dns',detail:'A'.repeat(1190)+'invalid-order-key-secret'+'B'.repeat(2000)}]}})});
  const run=await f.issue();assert.equal(run.result.message.length,1200);assert.equal(run.result.domain,undefined);assert.doesNotMatch(JSON.stringify({run,events:f.store.runEvents(run.id)}),/invalid-order|key-secret/);
});

test('authorization diagnostic reads stop if the certificate revision changes during the CA order request',async t=>{
  let calls=0,f:ReturnType<typeof invalidOrderFixture>;
  f=invalidOrderFixture(t,{getOrder:async()=>{f.db.run('UPDATE ops_platform_resources SET revision=revision+1 WHERE id=?',f.cert.id);return {status:'invalid',authorizations:['https://ca.example.test/auth/one']};},getAuthorizations:async()=>{calls++;return []}});
  const run=await f.issue();assert.equal(run.result.code,'acme_order_invalid');assert.equal(calls,0);assert(f.store.runEvents(run.id).some(event=>event.code==='certificate_revision_changed'));
});

test('a second order read after challenge verification checks invalid state and preserves its challenge explanation',async t=>{
  const api=providerFixture('aliyun');let reads=0,authorizations=0;
  const f=setup(t,api.fetcher,{resolveChallenge:async()=>true,acmeClientFactory:()=>({
    createAccount:async()=>({}),getAccountUrl:()=> 'https://ca.example.test/account/second',createOrder:async()=>({url:'https://ca.example.test/order/second'}),
    getOrder:async()=>({url:'https://ca.example.test/order/second',status:++reads===1?'pending':'invalid',authorizations:['https://ca.example.test/auth/second']}),
    getAuthorizations:async()=>[{url:'https://ca.example.test/auth/second',identifier:{value:'example.test'},status:++authorizations===1?'pending':'invalid',challenges:[{type:'dns-01',token:'second-read-token-secret',status:authorizations===1?'pending':'invalid',...(authorizations>1?{error:{type:'urn:ietf:params:acme:error:dns',detail:'DNS lookup failed after challenge submission'}}:{})}]}],
    getChallengeKeyAuthorization:async()=> 'second-read-txt-secret',completeChallenge:async()=>({}),waitForValidStatus:async()=>({status:'valid'}),
    finalizeOrder:async()=>{throw Error('invalid order must not finalize')},getCertificate:async()=>{throw Error('invalid order must not download')},
  })});
  const cred=f.store.create('credential','DNS',{provider:'aliyun',access_key_id:'second-id',access_key_secret:'second-secret'},'admin');
  const zone=f.store.create('dns_zone','Zone',{domain:'example.test',credential_id:cred.id},'admin');
  const account=f.store.create('acme_account','ACME',{email:'ops@example.test',directory_url:'letsencrypt-staging',terms_agreed:true},'admin');
  const cert=f.store.create('certificate','Second read',{source:'acme',domains:['example.test'],acme_account_id:account.id,dns_zone_ids:[zone.id]},'admin');
  const run=await f.controller.perform(cert,'issue',{},'admin');assert.equal(run.state,'failed');assert.equal(run.result.code,'acme_order_invalid');assert.match(run.result.message,/after challenge submission/);
  assert.equal(reads,2);assert.equal(authorizations,2);assert.equal(f.db.get<any>('SELECT state FROM ops_acme_orders')!.state,'invalid');assert.equal(f.store.get(cert.id).status.challenge_cleanup,'complete');
  assert.deepEqual(f.store.runEvents(run.id).filter(event=>event.phase==='get_order').map(event=>event.state),['running','succeeded','running','failed']);
  assert.doesNotMatch(JSON.stringify({run,events:f.store.runEvents(run.id)}),/second-read-token-secret|second-read-txt-secret/);
});
test("restart recovers certificate status even when its interrupted receipt is older than the history page",async t=>{
  const f=setup(t),cert=f.store.create('certificate','Interrupted',{source:'self_signed',domains:['example.test'],auto_renew:false},'admin');
  const run=await f.controller.perform(cert,'issue',{},'admin'),version=f.store.get(cert.id).status.certificate_version;
  f.db.run("UPDATE ops_platform_runs SET state='running' WHERE id=?",run.id);
  f.store.patchStatus(cert.id,{state:'issuing',last_run_id:run.id});
  for(let i=0;i<101;i++)f.db.run("INSERT INTO ops_platform_runs SELECT ?,resource_id,resource_revision,agent_id,'inspect','succeeded',payload_cipher,'{}',job_id,actor,NULL,'2099-01-01T00:00:00Z',updated_at FROM ops_platform_runs WHERE id=?",'later-'+i,run.id);
  assert(!f.store.actions(cert.id).some(r=>r.id===run.id));
  await f.controller.close?.();await f.store.close();
  const store=new OperationsPlatformStore(f.deps,f.jobs),controller=createCertificateController({...f.options,store});
  try {
    assert.equal(store.get(cert.id).status.state,'unknown');assert.equal(store.get(cert.id).status.last_error_phase,'interrupted');
    assert.equal(store.get(cert.id).status.certificate_version,version);
    await controller.tick?.();assert.equal(f.db.get<any>('SELECT COUNT(*) n FROM ops_platform_runs')!.n,102);
    assert(store.runEvents(run.id).some(e=>e.phase==='interrupted'));
  }finally{await controller.close?.();await store.close();}
});
test("ACME account, DNS-01 order, same-label TXT cleanup and saved version form a durable lifecycle", async (t) => {
  const api = providerFixture("aliyun");
  let f: ReturnType<typeof setup>,
    completed = 0,
    registrations = 0,
    orders = 0,
    accountKeys: string[] = [];
  const names = ["example.test", "*.example.test"];
  const acmeClientFactory = (config: any) => {
    accountKeys.push(config.accountKey);
    return {
      getAccountUrl: () => "https://acme.example.test/accounts/one",
      createAccount: async () => {
        registrations++;
        return {};
      },
      createOrder: async () => {
        orders++;
        return {
          url: "https://acme.example.test/orders/one",
          status: "pending",
        };
      },
      getOrder: async (order: any) => ({
        ...order,
        status: completed === 2 ? "ready" : "pending",
      }),
      getAuthorizations: async () =>
        [0, 1].map((i) => ({
          url: "https://acme.example.test/authz/" + i,
          status: "pending",
          identifier: { value: "example.test" },
          wildcard: i === 1,
          challenges: [
            {
              type: "dns-01",
              url: "https://acme.example.test/challenges/" + i,
              status: "pending",
              token: "token-" + i,
            },
          ],
        })),
      getChallengeKeyAuthorization: async (challenge: any) =>
        "value-" + challenge.token,
      completeChallenge: async () => {
        completed++;
        assert.equal(
          api.records.filter((r) => r.type === "TXT").length,
          completed,
        );
        return {};
      },
      waitForValidStatus: async (item: any) => ({ ...item, status: "valid" }),
      finalizeOrder: async (order: any) => ({ ...order, status: "valid" }),
      getCertificate: async () => {
        const row = f.db.get<any>(
            "SELECT payload_cipher FROM ops_acme_orders ORDER BY created_at DESC LIMIT 1",
          ),
          pending = JSON.parse(f.deps.decrypt(row.payload_cipher)),
          privateKey = createPrivateKey(pending.private_key_pem),
          alg = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
        const keys = {
          privateKey: await webcrypto.subtle.importKey(
            "pkcs8",
            privateKey.export({ format: "der", type: "pkcs8" }),
            alg,
            true,
            ["sign"],
          ),
          publicKey: await webcrypto.subtle.importKey(
            "spki",
            createPublicKey(privateKey).export({ format: "der", type: "spki" }),
            alg,
            true,
            ["verify"],
          ),
        };
        const certificate = await X509CertificateGenerator.createSelfSigned(
          {
            name: "CN=example.test",
            keys: keys as any,
            signingAlgorithm: alg,
            notBefore: new Date(f.deps.now().getTime() - 1000),
            notAfter: new Date(f.deps.now().getTime() + 90 * 86400000),
            extensions: [
              new SubjectAlternativeNameExtension(
                names.map((value) => ({ type: "dns" as const, value })),
              ),
            ],
          },
          webcrypto as any,
        );
        return certificate.toString("pem");
      },
    } as any;
  };
  f = setup(t, api.fetcher, {
    acmeClientFactory,
    resolveChallenge: async () => true,
  });
  const cred = f.store.create(
      "credential",
      "DNS",
      { provider: "aliyun", access_key_id: "id", access_key_secret: "secret" },
      "admin",
    ),
    zone = f.store.create(
      "dns_zone",
      "Zone",
      { domain: "example.test", credential_id: cred.id },
      "admin",
    ),
    account = f.store.create(
      "acme_account",
      "ACME",
      {
        email: "ops@example.test",
        directory_url: "letsencrypt-staging",
        terms_agreed: true,
      },
      "admin",
    ),
    certificate = legacyCertificate(f,
      "ACME Certificate",
      {
        source: "acme",
        domains: names,
        acme_account_id: account.id,
        dns_zone_ids: [zone.id],
        auto_renew: true,
      },
    );
  const run = await f.controller.perform(certificate, "issue", {}, "admin");
  assert.equal(run.state, "succeeded");
  const steps=f.store.runEvents(run.id);
  for(const phase of ['acme_account','create_csr','create_order','get_authorizations','dns_prepare','dns_propagation','challenge_submit','challenge_verify','order_finalize','certificate_download','dns_cleanup','certificate_save','complete'])
    assert(steps.some(e=>e.phase===phase&&e.state==='succeeded'),phase);
  assert.doesNotMatch(JSON.stringify(steps),/token-[01]|value-token|BEGIN|key_cipher|payload_cipher/);
  assert.equal(registrations, 1);
  assert.equal(orders, 1);
  assert.equal(api.records.filter((r) => r.type === "TXT").length, 0);
  assert.equal(api.records[0].type, "MX");
  assert.equal(
    f.db.get<any>("SELECT state FROM ops_acme_orders")?.state,
    "saved",
  );
  assert.equal(
    f.db.all<any>("SELECT * FROM ops_acme_challenges WHERE state='cleaned'")
      .length,
    2,
  );
  assert.ok(
    getCertificateMaterial(f.store, certificate.id).certificate_version,
  );
  assert.equal(
    JSON.stringify(f.db.all("SELECT * FROM ops_acme_orders")).includes("BEGIN"),
    false,
  );
  await f.controller.perform(account, "register", {}, "admin");
  assert.equal(registrations, 1);
  assert.equal(accountKeys[0], accountKeys[1]);
});

test("Tencent and Volcengine signatures match independently calculated fixed protocol vectors", async () => {
  const now = () => new Date("2026-10-29T02:00:00Z"),
    seen: string[] = [];
  const tencent = new CloudClient(
    {
      provider: "tencent",
      access_key_id: "test-id",
      access_key_secret: "test-secret",
    },
    async (_url, init) => {
      seen.push(new Headers(init?.headers).get("authorization")!);
      return json({ Response: {} });
    },
    now,
  );
  await tencent.request(
    "tencent",
    "dnspod",
    "DescribeRecordList",
    "2021-03-23",
    { Domain: "example.test" },
  );
  assert.equal(
    seen[0],
    "TC3-HMAC-SHA256 Credential=test-id/2026-10-29/dnspod/tc3_request, SignedHeaders=content-type;host, Signature=559cd50e7cf20580ff75198737c89818e3ab742ab3fe2e2b90ec12c104845f62",
  );
  const volcengine = new CloudClient(
    {
      provider: "volcengine",
      access_key_id: "test-id",
      access_key_secret: "test-secret",
    },
    async (_url, init) => {
      seen.push(new Headers(init?.headers).get("authorization")!);
      return json({ ResponseMetadata: {}, Result: {} });
    },
    now,
  );
  await volcengine.request(
    "volcengine",
    "CDN",
    "DescribeCdnConfig",
    "2021-03-01",
    { Domain: "example.test" },
  );
  assert.equal(
    seen[1],
    "HMAC-SHA256 Credential=test-id/20261029/cn-north-1/CDN/request, SignedHeaders=host;x-content-sha256;x-date, Signature=1932588bde24616a26a2507a65e6c80b75f48d327035d1443548e7376dd04e02",
  );
});

test("DNSPod record IDs retain all 64 bits through list and modify requests", async () => {
  let body = "";
  const client = new CloudClient(
    { provider: "tencent", access_key_id: "id", access_key_secret: "secret" },
    async (_url, init) => {
      const action = new Headers(init?.headers).get("x-tc-action");
      if (action === "DescribeRecordList")
        return new Response(
          '{"Response":{"RecordList":[{"RecordId":18446744073709551614,"Name":"www","Type":"A","Value":"192.0.2.1","TTL":600,"Status":"ENABLE"}]}}',
        );
      body = String(init?.body);
      return new Response('{"Response":{"RecordId":18446744073709551614}}');
    },
  );
  const records = await client.listRecords("example.test");
  assert.equal(records[0].id, "18446744073709551614");
  await client.writeRecord("example.test", {
    ...records[0],
    value: "192.0.2.2",
  });
  assert.ok(body.includes('"RecordId":18446744073709551614'));
});

test("large DNS zones synchronize every provider page and expose a bounded authenticated record page", async (t) => {
  const source = Array.from({ length: 650 }, (_, index) => ({
      RecordId: String(index + 1),
      RR: "host-" + String(index).padStart(3, "0"),
      Type: "A",
      Value: "192.0.2.1",
      TTL: 600,
      Status: "ENABLE",
    })),
    pages: number[] = [];
  const f = setup(t, async (_url, init) => {
    const data = new URLSearchParams(String(init?.body)),
      page = Number(data.get("PageNumber"));
    pages.push(page);
    return json({
      TotalCount: source.length,
      DomainRecords: { Record: source.slice((page - 1) * 500, page * 500) },
    });
  });
  f.deps.auth = {
    requireAdmin(ctx: any) {
      if (ctx.user.role !== "admin") throw Error("denied");
    },
    user(req: any) {
      return req.headers.authorization === "test-admin"
        ? { id: "admin", name: "Admin", role: "admin" }
        : undefined;
    },
  } as any;
  (f.deps.router as Router).auth = f.deps.auth;
  const credential = f.store.create(
      "credential",
      "DNS",
      { provider: "aliyun", access_key_id: "id", access_key_secret: "secret" },
      "admin",
    ),
    zone = f.store.create(
      "dns_zone",
      "Zone",
      { domain: "example.test", credential_id: credential.id },
      "admin",
    );
  const run = await f.controller.perform(zone, "sync", {}, "admin");
  assert.equal(run.state, "succeeded");
  assert.deepEqual(pages, [1, 2]);
  assert.equal(f.store.get(zone.id).status.records.length, 100);
  assert.equal(f.store.get(zone.id).status.record_count, 650);
  const server = createServer((req, res) => {
    void (f.deps.router as Router).handle(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const url =
    "http://127.0.0.1:" +
    (server.address() as any).port +
    "/api/v1/ops/resources/" +
    zone.id +
    "/records?offset=500&limit=100";
  const denied = await fetch(url);
  assert.equal(denied.status, 401);
  const response = await fetch(url, {
      headers: { authorization: "test-admin" },
    }),
    page = (await response.json()) as any;
  assert.equal(page.total, 650);
  assert.equal(page.records.length, 100);
  assert.equal(page.records[0].name, "host-500");
});

test("partial cloud deployment retains successful domain evidence and inspect never writes", async (t) => {
  let uploads = 0,
    binds = 0;
  const domains = new Map<string, string>();
  const f = setup(t, async (url, init) => {
    const action = new URL(String(url)).searchParams.get("Action"),
      data = JSON.parse(String(init?.body));
    if (action === "AddCertificate") {
      uploads++;
      return json({ ResponseMetadata: {}, Result: { CertId: "remote" } });
    }
    if (action === "DescribeCdnConfig")
      return json({
        ResponseMetadata: {},
        Result: {
          DomainConfig: {
            HTTPS: {
              Switch: true,
              CertInfo: { CertId: domains.get(data.Domain) ?? "old" },
            },
          },
        },
      });
    if (action === "BatchDeployCert") {
      binds++;
      const success = data.Domain === "one.example.test";
      if (success) domains.set(data.Domain, "remote");
      return json({
        ResponseMetadata: {},
        Result: {
          DeployResult: [
            {
              Domain: data.Domain,
              Status: success ? "success" : "fail",
              ErrorMsg: "private vendor detail",
            },
          ],
        },
      });
    }
    throw Error("unexpected");
  });
  const credential = f.store.create(
      "credential",
      "Cloud",
      {
        provider: "volcengine",
        access_key_id: "id",
        access_key_secret: "secret",
      },
      "admin",
    ),
    certificate = f.store.create(
      "certificate",
      "Cert",
      {
        source: "self_signed",
        domains: ["*.example.test"],
      },
      "admin",
    );
  await f.controller.perform(certificate, "issue", {}, "admin");
  const target = f.store.create(
      "certificate_target",
      "CDN",
      {
        certificate_id: certificate.id,
        type: "cloud",
        provider: "volcengine",
        credential_id: credential.id,
        product: "cdn",
        domains: ["one.example.test", "two.example.test"],
      },
      "admin",
    ),
    material = getCertificateMaterial(f.store, certificate.id),
    result = await deployCloudCertificate(f.options, target, material, "admin");
  assert.equal(result.state, "failed");
  assert.equal(result.domains[0].verified, true);
  assert.equal(result.domains[1].state, "failed");
  assert.equal(JSON.stringify(result).includes("private vendor detail"), false);
  const inspected = await inspectCloudCertificate(
    f.options,
    target,
    material,
    "admin",
  );
  assert.equal(inspected.state, "unknown");
  assert.equal(inspected.domains[0].verified, true);
  assert.equal(uploads, 1);
  assert.equal(binds, 2);
});

test("an ambiguous cloud upload persists its fence across retries and discards raw transport errors", async (t) => {
  let uploads = 0;
  const f = setup(t, async () => {
      uploads++;
      throw Error("private cloud transport error");
    }),
    credential = f.store.create(
      "credential",
      "Cloud",
      { provider: "tencent", access_key_id: "id", access_key_secret: "secret" },
      "admin",
    ),
    certificate = f.store.create(
      "certificate",
      "Cert",
      { source: "self_signed", domains: ["example.test"] },
      "admin",
    );
  await f.controller.perform(certificate, "issue", {}, "admin");
  const target = f.store.create(
      "certificate_target",
      "CDN",
      {
        certificate_id: certificate.id,
        type: "cloud",
        provider: "tencent",
        credential_id: credential.id,
        product: "cdn",
        domains: ["example.test"],
      },
      "admin",
    ),
    material = getCertificateMaterial(f.store, certificate.id);
  await assert.rejects(
    deployCloudCertificate(f.options, target, material, "admin"),
    (error: any) => error.state === "unknown",
  );
  await assert.rejects(
    deployCloudCertificate(f.options, target, material, "admin"),
    /upload_unknown/,
  );
  assert.equal(uploads, 1);
  assert.equal(
    f.db.get<any>("SELECT state FROM ops_cloud_certificates")?.state,
    "unknown",
  );
});

test("periodic DNS observation refreshes external edits with a five minute bound and rechecks authorization", async (t) => {
  const api = providerFixture("tencent"),
    f = setup(t, api.fetcher),
    credential = f.store.create(
      "credential",
      "DNS",
      { provider: "tencent", access_key_id: "id", access_key_secret: "secret" },
      "admin",
    ),
    zone = f.store.create(
      "dns_zone",
      "Zone",
      { domain: "example.test", credential_id: credential.id },
      "admin",
    );
  await f.controller.tick?.();
  const first = api.calls.length;
  assert.equal(first, 1);
  await f.controller.tick?.();
  assert.equal(api.calls.length, first);
  api.records[0].value = "outside-change.example.test";
  f.advance(6 / 1440);
  await f.controller.tick?.();
  assert.equal(api.calls.length, first + 1);
  assert.equal(
    f.store.get(zone.id).status.records[0].value,
    "outside-change.example.test",
  );
  f.db.run("UPDATE users SET active=0 WHERE id='admin'");
  f.advance(6 / 1440);
  await f.controller.tick?.();
  assert.equal(api.calls.length, first + 1);
});

test("saving an undeployed website certificate change retains the published certificate reference", (t) => {
  const f = setup(t);
  f.store.register("website", { validate: (spec) => spec });
  const active = f.store.create(
      "certificate",
      "Active",
      { source: "self_signed", domains: ["example.test"] },
      "admin",
    ),
    draft = f.store.create(
      "certificate",
      "Draft",
      { source: "self_signed", domains: ["*.example.test"] },
      "admin",
    ),
    site = f.store.create(
      "website",
      "Website",
      { certificate_id: active.id },
      "admin",
    );
  f.store.patchStatus(site.id, { desired_revision: 1 });
  f.store.update(site.id, 1, site.name, { certificate_id: draft.id }, "admin");
  assert.throws(
    () => f.store.remove(active.id, active.revision),
    /resource_in_use/,
  );
  f.store.patchStatus(site.id, { desired_revision: 2 });
  f.store.remove(active.id, active.revision);
  assert.throws(() => f.store.get(active.id), /not_found/);
});
