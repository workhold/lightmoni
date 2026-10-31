import {
  createHash,
  randomBytes,
  randomUUID,
  webcrypto,
  X509Certificate,
} from "node:crypto";
import { isIP } from "node:net";
import { isAbsolute } from "node:path";
import * as acme from "acme-client";
import {
  BasicConstraintsExtension,
  ExtendedKeyUsageExtension,
  KeyUsagesExtension,
  KeyUsageFlags,
  SubjectAlternativeNameExtension,
  X509CertificateGenerator,
} from "@peculiar/x509";
import { certificateMetadata } from "../operations/certificates.js";
import { HTTPError } from "../shared/http.js";
import { id } from "../shared/crypto.js";
import {
  CloudError,
  clientFor,
  deployCloudCertificate,
  dnsPropagation,
  ensureDnsRecords,
  initDNSSchema,
  inspectCloudCertificate,
  normalizeDomain,
  publicCredential,
  publishDNSRecords,
  recordInput,
  validateCredential,
  visibleRecords,
  zoneFor,
} from "./cloud.js";
import type { DNSInput } from "./cloud.js";
import type {
  DomainController,
  PlatformOptions,
  PlatformResource,
  PlatformStore,
} from "./types.js";

function need(value: unknown, code: string): asserts value {
  if (!value) throw new HTTPError(400, code);
}
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const safeError = (error: unknown) =>
  error instanceof CloudError
    ? error.code
    : error instanceof HTTPError
      ? error.message
      : "certificate_operation_failed";
const integer = (
  value: any,
  fallback: number,
  min: number,
  max: number,
  code: string,
) => {
  const n = value ?? fallback;
  need(Number.isInteger(n) && n >= min && n <= max, code);
  return n;
};
const ref = (value: any, code = "invalid_resource_reference") => {
  need(typeof value === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(value), code);
  return value;
};
function domains(input: any): string[] {
  need(
    Array.isArray(input) && input.length > 0 && input.length <= 100,
    "certificate_domains_required",
  );
  return [...new Set<string>(input.map((d) => normalizeDomain(d, true)))];
}
function directoryURL(input: any): string {
  if (input === "letsencrypt-production" || !input)
    return acme.directory.letsencrypt.production;
  if (input === "letsencrypt-staging")
    return acme.directory.letsencrypt.staging;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new HTTPError(400, "invalid_acme_directory");
  }
  need(
    url.protocol === "https:" && !url.username && !url.password && !url.hash,
    "invalid_acme_directory",
  );
  return url.toString();
}
export interface CertificateMaterial {
  certificate_pem: string;
  private_key_pem: string;
  certificate_version: string;
  version: string;
  fingerprint_sha256: string;
  domains: string[];
  expires_at: string;
  not_before: string;
}
export function getCertificateMaterial(
  store: PlatformStore,
  certificateID: string,
): CertificateMaterial {
  const resource = store.get(certificateID, "certificate"),
    version = resource.status.certificate_version;
  if (!version) throw new HTTPError(409, "certificate_not_issued");
  const row = store.deps.db.get<any>(
    "SELECT * FROM ops_certificate_versions WHERE id=? AND certificate_id=?",
    version,
    certificateID,
  );
  if (!row) throw new HTTPError(409, "certificate_version_missing");
  return {
    ...JSON.parse(store.deps.decrypt(row.material_cipher)),
    ...JSON.parse(row.metadata_json),
    certificate_version: row.id,
    version: row.id,
  };
}
function initSchema(options: PlatformOptions): void {
  options.deps.db
    .exec(`CREATE TABLE IF NOT EXISTS ops_certificate_versions(id TEXT PRIMARY KEY,certificate_id TEXT NOT NULL,fingerprint TEXT NOT NULL,material_cipher TEXT NOT NULL,metadata_json TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(certificate_id,fingerprint));
    CREATE TABLE IF NOT EXISTS ops_acme_accounts(resource_id TEXT PRIMARY KEY,key_cipher TEXT NOT NULL,account_url TEXT NOT NULL DEFAULT '',updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS ops_acme_orders(id TEXT PRIMARY KEY,certificate_id TEXT NOT NULL,resource_revision INTEGER NOT NULL,account_id TEXT NOT NULL,state TEXT NOT NULL,payload_cipher TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS ops_acme_orders_certificate ON ops_acme_orders(certificate_id,state);
    CREATE TABLE IF NOT EXISTS ops_acme_challenges(owner_id TEXT PRIMARY KEY,order_id TEXT NOT NULL,zone_id TEXT NOT NULL,state TEXT NOT NULL,updated_at TEXT NOT NULL);`);
  initDNSSchema(options);
}
export function validateCertificate(
  spec: Record<string, any>,
  previous?: Record<string, any>,
): Record<string, any> {
  need(
    ["acme", "uploaded", "self_signed"].includes(spec.source),
    "invalid_certificate_source",
  );
  const out: Record<string, any> = {
    source: spec.source,
    domains: domains(spec.domains),
    auto_renew: spec.source !== "uploaded" && spec.auto_renew === true,
    renew_before_days: integer(
      spec.renew_before_days,
      30,
      1,
      365,
      "invalid_renewal_window",
    ),
  };
  if (spec.source === "acme") {
    out.acme_account_id = ref(spec.acme_account_id);
    need(
      Array.isArray(spec.dns_zone_ids) &&
        spec.dns_zone_ids.length > 0 &&
        spec.dns_zone_ids.length <= 100,
      "dns_zones_required",
    );
    out.dns_zone_ids = [
      ...new Set(spec.dns_zone_ids.map((id: any) => ref(id))),
    ];
  } else if (spec.source === "self_signed")
    out.validity_days = integer(
      spec.validity_days,
      90,
      1,
      825,
      "invalid_certificate_validity",
    );
  else {
    for (const key of ["certificate_pem", "private_key_pem"])
      out[key] = spec[key] || previous?.[key];
    need(
      typeof out.certificate_pem === "string" &&
        Buffer.byteLength(out.certificate_pem) <= 128 * 1024 &&
        typeof out.private_key_pem === "string" &&
        Buffer.byteLength(out.private_key_pem) <= 64 * 1024,
      "certificate_material_required",
    );
    try {
      certificateMetadata(
        out.certificate_pem,
        out.private_key_pem,
        out.domains,
        new Date(),
        false,
      );
    } catch (error) {
      throw new HTTPError(
        400,
        error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
          ? error.message.toLowerCase()
          : "invalid_certificate_material",
      );
    }
  }
  return out;
}
export function publicCertificate(
  spec: Record<string, any>,
): Record<string, any> {
  const { certificate_pem, private_key_pem, ...rest } = spec;
  return {
    ...rest,
    has_certificate: !!certificate_pem,
    has_private_key: !!private_key_pem,
  };
}
export function validateCertificateTarget(
  spec: Record<string, any>,
  previous?: Record<string, any>,
): Record<string, any> {
  const out: Record<string, any> = {
    certificate_id: ref(spec.certificate_id),
    type: spec.type,
    enabled: spec.enabled === true,
  };
  need(
    ["directory", "cloud", "hook"].includes(spec.type),
    "invalid_certificate_target_type",
  );
  if (spec.type === "cloud") {
    need(
      ["aliyun", "tencent", "volcengine"].includes(spec.provider) &&
        spec.product === "cdn",
      "unsupported_certificate_cloud_target",
    );
    Object.assign(out, {
      provider: spec.provider,
      product: "cdn",
      credential_id: ref(spec.credential_id),
      domains: domains(spec.domains),
    });
    need(
      !out.domains.some((domain: string) => domain.startsWith("*.")),
      "cdn_exact_domain_required",
    );
  } else {
    out.agent_id = ref(spec.agent_id);
    if (spec.type === "directory") {
      need(
        typeof spec.path === "string" &&
          isAbsolute(spec.path) &&
          !/[\0\r\n]/.test(spec.path) &&
          !spec.path.split("/").includes("..") &&
          spec.path !== "/",
        "invalid_certificate_directory",
      );
      out.path = spec.path;
      for (const [key, fallback] of [
        ["certificate_file", "fullchain.pem"],
        ["private_key_file", "privkey.pem"],
      ]) {
        const value = spec[key] ?? fallback;
        need(
          typeof value === "string" &&
            /^[A-Za-z0-9][A-Za-z0-9_.-]{0,120}$/.test(value),
          "invalid_certificate_filename",
        );
        out[key] = value;
      }
      need(
        out.certificate_file !== out.private_key_file,
        "certificate_filenames_conflict",
      );
      for (const [key, fallback] of [
        ["mode", "0644"],
        ["private_key_mode", "0600"],
      ]) {
        const mode = spec[key] ?? fallback;
        need(
          ["0600", "0640", "0644"].includes(mode),
          "invalid_certificate_mode",
        );
        if (key === "private_key_mode")
          need(mode !== "0644", "private_key_world_readable");
        out[key] = mode;
      }
      for (const key of ["owner", "group"])
        if (spec[key] !== undefined && spec[key] !== "") {
          need(
            typeof spec[key] === "string" &&
              /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(spec[key]),
            "invalid_certificate_owner",
          );
          out[key] = spec[key];
        }
    } else {
      const script = spec.script || previous?.script;
      need(
        typeof script === "string" &&
          script.trim().length > 0 &&
          Buffer.byteLength(script) <= 64 * 1024 &&
          !script.includes("\0"),
        "invalid_certificate_hook_script",
      );
      out.script = script;
      out.interpreter = spec.interpreter ?? "/bin/sh";
      need(
        ["/bin/sh", "/bin/bash", "/usr/bin/python3"].includes(out.interpreter),
        "unsupported_hook_interpreter",
      );
      out.timeout_ms = integer(
        spec.timeout_ms,
        60000,
        1000,
        300000,
        "invalid_hook_timeout",
      );
      let env = spec.env;
      if (spec.clear_env === true) env = {};
      else if (!env || Object.keys(env).length === 0) env = previous?.env ?? {};
      need(
        typeof env === "object" &&
          !Array.isArray(env) &&
          Object.keys(env).length <= 64,
        "invalid_hook_environment",
      );
      out.env = {};
      for (const [key, value] of Object.entries(env)) {
        need(
          /^[A-Za-z_][A-Za-z0-9_]{0,99}$/.test(key) &&
            !/^LIGHTMONI_|^(PATH|LD_PRELOAD|LD_LIBRARY_PATH|NODE_OPTIONS|PYTHONPATH|BASH_ENV|ENV)$/.test(
              key,
            ),
          "invalid_hook_environment_key",
        );
        need(
          typeof value === "string" &&
            Buffer.byteLength(value) <= 8192 &&
            !value.includes("\0"),
          "invalid_hook_environment_value",
        );
        out.env[key] = value;
      }
    }
  }
  return out;
}
export function publicCertificateTarget(
  spec: Record<string, any>,
): Record<string, any> {
  const { env, script, ...rest } = spec;
  return {
    ...rest,
    ...(script ? { has_script: true } : {}),
    ...(env
      ? { env_keys: Object.keys(env), has_env: Object.keys(env).length > 0 }
      : {}),
  };
}
export async function selfSignedCertificate(
  names: string[],
  validityDays: number,
  now: Date,
): Promise<{ certificate_pem: string; private_key_pem: string }> {
  const algorithm = {
    name: "RSASSA-PKCS1-v1_5",
    hash: "SHA-256",
    publicExponent: new Uint8Array([1, 0, 1]),
    modulusLength: 2048,
  };
  const keys = await webcrypto.subtle.generateKey(algorithm, true, [
    "sign",
    "verify",
  ]);
  const certificate = await X509CertificateGenerator.createSelfSigned(
    {
      serialNumber: randomBytes(16).toString("hex"),
      name: "CN=" + names[0],
      keys: keys as any,
      signingAlgorithm: algorithm,
      notBefore: new Date(now.getTime() - 60000),
      notAfter: new Date(now.getTime() + validityDays * 86400000),
      extensions: [
        new BasicConstraintsExtension(false, undefined, true),
        new KeyUsagesExtension(
          KeyUsageFlags.digitalSignature | KeyUsageFlags.keyEncipherment,
          true,
        ),
        new ExtendedKeyUsageExtension(["1.3.6.1.5.5.7.3.1"]),
        new SubjectAlternativeNameExtension(
          names.map((value) => ({
            type: isIP(value) ? ("ip" as const) : ("dns" as const),
            value,
          })),
        ),
      ],
    },
    webcrypto as any,
  );
  const key = Buffer.from(
    await webcrypto.subtle.exportKey("pkcs8", keys.privateKey),
  );
  return {
    certificate_pem: certificate.toString("pem"),
    private_key_pem:
      "-----BEGIN PRIVATE KEY-----\n" +
      key
        .toString("base64")
        .match(/.{1,64}/g)!
        .join("\n") +
      "\n-----END PRIVATE KEY-----\n",
  };
}

export interface CertificateControllerOptions extends PlatformOptions {
  acmeClientFactory?: (options: acme.ClientOptions) => acme.Client;
  resolveChallenge?: (
    name: string,
    type: string,
    value: string,
  ) => Promise<boolean>;
}
export function createCertificateController(
  options: CertificateControllerOptions,
): DomainController {
  const { store, deps } = options,
    db = deps.db,
    at = () => deps.now().toISOString(),
    inFlight = new Set<string>();
  initSchema(options);
  const authorize = (actor: string) => {
    if (!store.authorized(actor))
      throw new HTTPError(403, "operations_authorization_revoked");
  };
  const referenced = (id: string, kinds?: string[]) =>
    store.list().some((r) => {
      if (r.id === id || (kinds && !kinds.includes(r.kind))) return false;
      const specs = [r.spec],
        desiredRevision = Number(r.status.desired_revision ?? r.revision);
      if (desiredRevision !== r.revision) {
        const row = db.get<any>(
          "SELECT spec_cipher FROM ops_platform_revisions WHERE resource_id=? AND revision=?",
          r.id,
          desiredRevision,
        );
        if (!row) throw new HTTPError(409, "authorized_revision_missing");
        specs.push(JSON.parse(deps.decrypt(row.spec_cipher)));
      }
      // Each website cluster can still serve a separately frozen revision.
      if (
        r.kind === "website" &&
        db.get(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='ops_platform_website_deployments'",
        )
      ) {
        for (const deployed of db.all<any>(
          "SELECT DISTINCT desired_revision FROM ops_platform_website_deployments WHERE website_id=? AND desired_revision>0 AND enabled=1",
          r.id,
        )) {
          const saved = db.get<any>(
            "SELECT spec_cipher FROM ops_platform_revisions WHERE resource_id=? AND revision=?",
            r.id,
            deployed.desired_revision,
          );
          if (!saved) throw new HTTPError(409, "authorized_revision_missing");
          specs.push(JSON.parse(deps.decrypt(saved.spec_cipher)));
        }
      }
      return specs.some((spec) =>
        [
          spec.credential_id,
          spec.acme_account_id,
          spec.certificate_id,
          ...(spec.dns_zone_ids ?? []),
          ...(spec.deployments ?? []).map(
            (deployment: any) => deployment.gateway_dns_zone_id,
          ),
          ...(spec.bindings ?? []).flatMap((binding: any) => [
            binding.certificate_id,
            binding.dns_zone_id,
          ]),
        ].includes(id),
      );
    });
  const denyReferenced = (resource: PlatformResource) => {
    if (referenced(resource.id))
      throw new HTTPError(409, "operations_resource_in_use");
  };
  store.register("credential", {
    validate(spec, previous) {
      const out = validateCredential(spec, previous);
      if (
        previous &&
        (out.provider !== previous.provider ||
          out.access_key_id !== previous.access_key_id)
      ) {
        for (const zone of store.list("dns_zone"))
          if (
            store.get(zone.spec.credential_id, "credential").spec
              .access_key_id === previous.access_key_id &&
            db.get("SELECT id FROM ops_dns_owned WHERE zone_id=?", zone.id)
          )
            throw new HTTPError(
              409,
              "dns_managed_credential_identity_immutable",
            );
      }
      return out;
    },
    publicSpec: publicCredential,
    beforeDelete: denyReferenced,
  });
  store.register("dns_zone", {
    validate(spec, previous) {
      const domain = normalizeDomain(spec.domain),
        credential = store.get(ref(spec.credential_id), "credential");
      need(
        ["aliyun", "tencent"].includes(credential.spec.provider),
        "dns_provider_not_supported",
      );
      const scope = spec.scope ? normalizeDomain(spec.scope) : domain;
      need(
        scope === domain || scope.endsWith("." + domain),
        "dns_scope_outside_zone",
      );
      if (
        previous &&
        (previous.domain !== domain ||
          previous.credential_id !== credential.id ||
          previous.scope !== scope)
      ) {
        for (const zone of store.list("dns_zone"))
          if (
            zone.spec.domain === previous.domain &&
            zone.spec.credential_id === previous.credential_id &&
            db.get("SELECT id FROM ops_dns_owned WHERE zone_id=?", zone.id)
          )
            throw new HTTPError(409, "dns_zone_has_managed_records");
      }
      return { domain, scope, credential_id: credential.id };
    },
    beforeDelete(resource) {
      denyReferenced(resource);
      if (db.get("SELECT id FROM ops_dns_owned WHERE zone_id=?", resource.id))
        throw new HTTPError(409, "dns_zone_has_managed_records");
    },
  });
  store.register("acme_account", {
    validate(spec, previous) {
      need(
        typeof spec.email === "string" &&
          /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(spec.email) &&
          spec.email.length <= 254,
        "invalid_acme_email",
      );
      need(spec.terms_agreed === true, "acme_terms_required");
      const out: Record<string, any> = {
        directory_url: directoryURL(spec.directory_url),
        email: spec.email,
        terms_agreed: true,
      };
      for (const key of ["eab_kid", "eab_hmac_key"])
        if (spec[key] || previous?.[key]) {
          const value = spec[key] || previous?.[key];
          need(
            typeof value === "string" &&
              value.length <= 4096 &&
              !/[\r\n\0]/.test(value),
            "invalid_acme_eab",
          );
          out[key] = value;
        }
      need(
        Boolean(out.eab_kid) === Boolean(out.eab_hmac_key),
        "acme_eab_pair_required",
      );
      return out;
    },
    publicSpec(spec) {
      const { eab_kid, eab_hmac_key, ...rest } = spec;
      return { ...rest, has_eab: !!eab_kid };
    },
    beforeDelete: denyReferenced,
  });
  store.register("certificate", {
    validate(spec, previous) {
      const out = validateCertificate(spec, previous);
      if (out.source === "acme") {
        store.get(out.acme_account_id, "acme_account");
        for (const id of out.dns_zone_ids) store.get(id, "dns_zone");
        for (const name of out.domains) selectZone(out, name);
      }
      return out;
    },
    publicSpec: publicCertificate,
    beforeDelete: denyReferenced,
  });
  store.register("certificate_target", {
    validate(spec, previous) {
      const out = validateCertificateTarget(spec, previous),
        certificate = store.get(out.certificate_id, "certificate");
      if (out.type === "cloud") {
        const cred = store.get(out.credential_id, "credential");
        need(
          cred.spec.provider === out.provider,
          "credential_provider_mismatch",
        );
        for (const name of out.domains)
          need(
            certificate.spec.domains.some(
              (n: string) =>
                n === name ||
                (n.startsWith("*.") &&
                  name.endsWith(n.slice(1)) &&
                  name.split(".").length === n.split(".").length),
            ),
            "certificate_target_domain_mismatch",
          );
      } else
        need(
          db.get("SELECT id FROM agents WHERE id=?", out.agent_id),
          "registered_agent_required",
        );
      return out;
    },
    publicSpec: publicCertificateTarget,
  });
  deps.router.get("/api/v1/ops/resources/:id/records", (ctx) => {
    try {
      deps.auth.requireAdmin(ctx);
      const zone = store.get(ctx.params.id, "dns_zone"),
        offset = integer(
          Number(ctx.url.searchParams.get("offset") ?? 0),
          0,
          0,
          500000,
          "invalid_dns_offset",
        ),
        limit = integer(
          Number(ctx.url.searchParams.get("limit") ?? 100),
          100,
          1,
          500,
          "invalid_dns_limit",
        ),
        keyword = (ctx.url.searchParams.get("keyword") ?? "").slice(0, 253),
        type = (ctx.url.searchParams.get("type") ?? "").toUpperCase();
      const where =
          "zone_id=? AND (?='' OR name LIKE ? OR value LIKE ?) AND (?='' OR type=?)",
        params = [
          zone.id,
          keyword,
          "%" + keyword + "%",
          "%" + keyword + "%",
          type,
          type,
        ];
      const total =
          db.get<any>(
            "SELECT COUNT(*) n FROM ops_dns_observed WHERE " + where,
            ...params,
          )?.n ?? 0,
        records = db
          .all<any>(
            "SELECT record_json FROM ops_dns_observed WHERE " +
              where +
              " ORDER BY name,type,record_id LIMIT ? OFFSET ?",
            ...params,
            limit,
            offset,
          )
          .map((row) => JSON.parse(row.record_json));
      ctx.json({
        records,
        total,
        offset,
        limit,
        last_sync_at: zone.status.last_sync_at ?? null,
      });
    } catch (error) {
      if (error instanceof HTTPError)
        ctx.json({ error: error.message }, error.status);
      else ctx.json({ error: "dns_records_query_failed" }, 500);
    }
  });

  function selectZone(
    spec: Record<string, any>,
    domain: string,
  ): PlatformResource {
    const name = domain.replace(/^\*\./, "");
    const candidates = (spec.dns_zone_ids ?? [])
      .map((id: string) => store.get(id, "dns_zone"))
      .filter(
        (z: PlatformResource) =>
          name === z.spec.scope || name.endsWith("." + z.spec.scope),
      )
      .sort(
        (a: PlatformResource, b: PlatformResource) =>
          b.spec.scope.length - a.spec.scope.length,
      );
    need(candidates.length > 0, "certificate_dns_zone_missing");
    return candidates[0];
  }
  async function accountClient(
    account: PlatformResource,
    actor: string,
  ): Promise<acme.Client> {
    const cacheID = account.id + ":" + digest(account.spec.directory_url);
    authorize(actor);
    let row = db.get<any>(
      "SELECT * FROM ops_acme_accounts WHERE resource_id=?",
      cacheID,
    );
    if (!row) {
      const key = (await acme.crypto.createPrivateRsaKey()).toString();
      db.run(
        "INSERT INTO ops_acme_accounts(resource_id,key_cipher,account_url,updated_at) VALUES(?,?,?,?)",
        cacheID,
        deps.encrypt(key),
        "",
        at(),
      );
      row = db.get<any>(
        "SELECT * FROM ops_acme_accounts WHERE resource_id=?",
        cacheID,
      );
    }
    const clientOptions = {
      directoryUrl: account.spec.directory_url,
      accountKey: deps.decrypt(row.key_cipher),
      ...(row.account_url ? { accountUrl: row.account_url } : {}),
      ...(account.spec.eab_kid
        ? {
            externalAccountBinding: {
              kid: account.spec.eab_kid,
              hmacKey: account.spec.eab_hmac_key,
            },
          }
        : {}),
      backoffAttempts: 8,
      backoffMin: 1000,
      backoffMax: 10000,
    };
    const client = options.acmeClientFactory
      ? options.acmeClientFactory(clientOptions)
      : new acme.Client(clientOptions);
    if (!row.account_url) {
      authorize(actor);
      try {
        await client.createAccount({
          termsOfServiceAgreed: true,
          contact: ["mailto:" + account.spec.email],
        });
      } catch {
        throw new CloudError("acme_account_registration_failed");
      }
      db.run(
        "UPDATE ops_acme_accounts SET account_url=?,updated_at=? WHERE resource_id=?",
        client.getAccountUrl(),
        at(),
        cacheID,
      );
    }
    store.patchStatus(account.id, {
      state: "registered",
      account_url: client.getAccountUrl(),
      registered_at: at(),
    });
    return client;
  }
  async function cleanChallenges(
    orderID: string,
    actor: string,
  ): Promise<boolean> {
    let clean = true;
    for (const item of db.all<any>(
      "SELECT * FROM ops_acme_challenges WHERE order_id=? AND state<>'cleaned'",
      orderID,
    )) {
      try {
        authorize(actor);
        await ensureDnsRecords(options, item.zone_id, item.owner_id, [], actor);
        db.run(
          "UPDATE ops_acme_challenges SET state='cleaned',updated_at=? WHERE owner_id=?",
          at(),
          item.owner_id,
        );
      } catch {
        clean = false;
        db.run(
          "UPDATE ops_acme_challenges SET state='cleanup_failed',updated_at=? WHERE owner_id=?",
          at(),
          item.owner_id,
        );
      }
    }
    return clean;
  }
  async function issueACME(
    certificate: PlatformResource,
    actor: string,
  ): Promise<{ certificate_pem: string; private_key_pem: string }> {
    const account = store.get(certificate.spec.acme_account_id, "acme_account"),
      client = await accountClient(account, actor);
    let row = db.get<any>(
        "SELECT * FROM ops_acme_orders WHERE certificate_id=? AND resource_revision=? AND state IN ('created','pending','ready','processing','complete') ORDER BY created_at DESC LIMIT 1",
        certificate.id,
        certificate.revision,
      ),
      payload: any;
    if (row) {
      payload = JSON.parse(deps.decrypt(row.payload_cipher));
      if (!payload.order?.url)
        throw new CloudError("acme_order_result_unknown", "", true);
    } else {
      const [key, csr] = await acme.crypto.createCsr({
        altNames: certificate.spec.domains,
      });
      payload = { private_key_pem: key.toString(), csr: csr.toString() };
      const id = randomUUID();
      db.run(
        "INSERT INTO ops_acme_orders(id,certificate_id,resource_revision,account_id,state,payload_cipher,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
        id,
        certificate.id,
        certificate.revision,
        account.id,
        "created",
        deps.encrypt(JSON.stringify(payload)),
        at(),
        at(),
      );
      row = db.get<any>("SELECT * FROM ops_acme_orders WHERE id=?", id);
      authorize(actor);
      try {
        payload.order = await client.createOrder({
          identifiers: certificate.spec.domains.map((value: string) => ({
            type: "dns",
            value,
          })),
        });
      } catch {
        db.run(
          "UPDATE ops_acme_orders SET state='unknown',updated_at=? WHERE id=?",
          at(),
          row.id,
        );
        throw new CloudError("acme_order_result_unknown", "", true);
      }
      db.run(
        "UPDATE ops_acme_orders SET state='pending',payload_cipher=?,updated_at=? WHERE id=?",
        deps.encrypt(JSON.stringify(payload)),
        at(),
        row.id,
      );
    }
    try {
      if (row.state === "complete" && payload.certificate_pem)
        return {
          certificate_pem: payload.certificate_pem,
          private_key_pem: payload.private_key_pem,
        };
      let order = await client.getOrder(payload.order);
      if (order.status === "invalid")
        throw new CloudError("acme_order_invalid");
      if (order.status === "pending") {
        const authorizations = await client.getAuthorizations(order);
        for (const authz of authorizations) {
          if (authz.status === "valid") continue;
          authorize(actor);
          const challenge = authz.challenges.find((c) => c.type === "dns-01");
          if (!challenge) throw new CloudError("acme_dns_challenge_missing");
          const zone = selectZone(certificate.spec, authz.identifier.value),
            value = await client.getChallengeKeyAuthorization(challenge),
            fqdn =
              "_acme-challenge." + authz.identifier.value.replace(/^\*\./, ""),
            owner = "acme-" + digest(row.id + "\0" + authz.url);
          db.run(
            "INSERT OR IGNORE INTO ops_acme_challenges(owner_id,order_id,zone_id,state,updated_at) VALUES(?,?,?,?,?)",
            owner,
            row.id,
            zone.id,
            "pending",
            at(),
          );
          await ensureDnsRecords(
            options,
            zone.id,
            owner,
            [{ name: fqdn, type: "TXT", value, ttl: 600 }],
            actor,
          );
          db.run(
            "UPDATE ops_acme_challenges SET state='created',updated_at=? WHERE owner_id=?",
            at(),
            owner,
          );
          let propagated = false;
          for (let n = 0; n < 60; n++) {
            authorize(actor);
            if (
              await (options.resolveChallenge ?? dnsPropagation)(
                fqdn,
                "TXT",
                value,
              )
            ) {
              propagated = true;
              break;
            }
            await new Promise<void>((resolve) => setTimeout(resolve, 2000));
          }
          if (!propagated) throw new CloudError("acme_dns_propagation_pending");
          authorize(actor);
          await client.completeChallenge(challenge);
          await client.waitForValidStatus(challenge);
        }
        order = await client.getOrder(order);
      }
      if (order.status === "ready") {
        authorize(actor);
        order = await client.finalizeOrder(order, payload.csr);
      }
      if (order.status !== "valid")
        order = await client.waitForValidStatus(order);
      authorize(actor);
      const certificatePEM = await client.getCertificate(order);
      payload.order = order;
      payload.certificate_pem = certificatePEM;
      db.run(
        "UPDATE ops_acme_orders SET state='complete',payload_cipher=?,updated_at=? WHERE id=?",
        deps.encrypt(JSON.stringify(payload)),
        at(),
        row.id,
      );
      const cleanup = await cleanChallenges(row.id, actor);
      store.patchStatus(certificate.id, {
        challenge_cleanup: cleanup ? "complete" : "pending",
      });
      return {
        certificate_pem: certificatePEM,
        private_key_pem: payload.private_key_pem,
      };
    } catch (error) {
      // Retain a resumable order; cleanup records independently, including after process restart.
      const cleanup = await cleanChallenges(row.id, actor);
      store.patchStatus(certificate.id, {
        challenge_cleanup: cleanup ? "complete" : "pending",
        last_error: safeError(error),
      });
      if (error instanceof CloudError || error instanceof HTTPError)
        throw error;
      throw new CloudError("acme_issuance_failed");
    }
  }
  function saveVersion(
    certificate: PlatformResource,
    material: { certificate_pem: string; private_key_pem: string },
  ): Record<string, any> {
    let metadata: Record<string, any>;
    try {
      metadata = certificateMetadata(
        material.certificate_pem,
        material.private_key_pem,
        certificate.spec.domains,
        deps.now(),
      );
    } catch (error) {
      throw new CloudError(
        error instanceof Error && /^[A-Z0-9_]+$/.test(error.message)
          ? error.message.toLowerCase()
          : "invalid_certificate_material",
      );
    }
    const previous = db.get<any>(
        "SELECT id FROM ops_certificate_versions WHERE certificate_id=? AND fingerprint=?",
        certificate.id,
        metadata.fingerprint_sha256,
      ),
      version = previous?.id ?? id();
    const expires = Date.parse(metadata.expires_at),
      lifetime = expires - Date.parse(metadata.not_before),
      renewBefore = Math.min(
        certificate.spec.renew_before_days * 86400000,
        Math.floor(lifetime / 3),
      );
    db.transaction(() => {
      if (!previous)
        db.run(
          "INSERT INTO ops_certificate_versions(id,certificate_id,fingerprint,material_cipher,metadata_json,created_at) VALUES(?,?,?,?,?,?)",
          version,
          certificate.id,
          metadata.fingerprint_sha256,
          deps.encrypt(JSON.stringify(material)),
          JSON.stringify(metadata),
          at(),
        );
      store.patchStatus(certificate.id, {
        ...metadata,
        state: "issued",
        certificate_version: version,
        source: certificate.spec.source,
        issued_revision: certificate.revision,
        issued_at: at(),
        renew_after: new Date(expires - renewBefore).toISOString(),
        renewal_due: false,
        expiry_warning:
          Number(metadata.days_remaining) <= certificate.spec.renew_before_days,
        expired: false,
        last_error: null,
      });
      if (certificate.spec.source === "acme")
        db.run(
          "UPDATE ops_acme_orders SET state='saved',updated_at=? WHERE certificate_id=? AND resource_revision=? AND state='complete'",
          at(),
          certificate.id,
          certificate.revision,
        );
    });
    return { ...metadata, certificate_version: version, verified: true };
  }
  async function issue(
    certificate: PlatformResource,
    actor: string,
  ): Promise<Record<string, any>> {
    authorize(actor);
    let material: { certificate_pem: string; private_key_pem: string };
    if (certificate.spec.source === "uploaded")
      material = {
        certificate_pem: certificate.spec.certificate_pem,
        private_key_pem: certificate.spec.private_key_pem,
      };
    else if (certificate.spec.source === "self_signed")
      material = await selfSignedCertificate(
        certificate.spec.domains,
        certificate.spec.validity_days,
        deps.now(),
      );
    else material = await issueACME(certificate, actor);
    authorize(actor);
    const current = store.get(certificate.id, "certificate");
    if (current.revision !== certificate.revision)
      throw new HTTPError(409, "certificate_revision_changed");
    return saveVersion(certificate, material);
  }
  async function syncTarget(
    target: PlatformResource,
    actor: string,
    retry = false,
    automatic = false,
  ): Promise<any> {
    authorize(actor);
    const material = getCertificateMaterial(store, target.spec.certificate_id);
    try {
      certificateMetadata(
        material.certificate_pem,
        material.private_key_pem,
        target.spec.type === "cloud" ? target.spec.domains : material.domains,
        deps.now(),
      );
    } catch {
      throw new HTTPError(
        409,
        "certificate_not_currently_valid_or_domain_mismatch",
      );
    }
    const key =
      "certificate-target:" +
      target.id +
      ":" +
      target.revision +
      ":" +
      material.certificate_version;
    const prior = store
      .actions(target.id)
      .filter(
        (r) => r.dedupe_key === key || r.dedupe_key?.startsWith(key + ":"),
      );
    if (retry && prior.some((r) => r.state === "unknown"))
      throw new HTTPError(
        409,
        "verify_unknown_certificate_target_before_retry",
      );
    const latest = prior.sort((a, b) =>
      b.created_at.localeCompare(a.created_at),
    )[0];
    if (automatic && latest && ["failed", "unknown"].includes(latest.state))
      return latest;
    const verifying =
      automatic &&
      target.spec.type === "cloud" &&
      target.status.state === "verifying";
    const dedupe = retry
      ? key + ":retry:" + randomUUID()
      : verifying
        ? key + ":verify:" + Math.floor(deps.now().getTime() / 30000)
        : key;
    store.patchStatus(target.id, {
      desired_certificate_version: material.certificate_version,
      desired_revision: target.revision,
    });
    let run: any;
    if (target.spec.type === "cloud") {
      // Each new attempt starts with readback; the adapter reuses uploaded cloud certificate IDs.
      run = await store.run(
        target,
        "sync",
        actor,
        () => deployCloudCertificate(options, target, material, actor),
        dedupe,
      );
      const result = run.result ?? {},
        applied = run.state === "succeeded" && result.verified === true;
      store.patchStatus(target.id, {
        state: applied
          ? "applied"
          : run.state === "succeeded"
            ? "verifying"
            : run.state,
        last_run_id: run.id,
        domains: result.domains ?? [],
        last_error: result.code ?? result.error ?? null,
        observed_at: at(),
        ...(applied
          ? {
              applied_certificate_version: material.certificate_version,
              applied_revision: target.revision,
              fingerprint_sha256: material.fingerprint_sha256,
            }
          : {}),
      });
    } else {
      const config: Record<string, any> =
        target.spec.type === "directory"
          ? {
              ...target.spec,
              task: "certificate.install",
              certificate_id: target.spec.certificate_id,
              certificate_version: material.certificate_version,
              fingerprint_sha256: material.fingerprint_sha256,
              certificate_pem: material.certificate_pem,
              private_key_pem: material.private_key_pem,
            }
          : {
              task: "hook.run",
              hook_id: target.id,
              certificate_id: target.spec.certificate_id,
              certificate_version: material.certificate_version,
              script: target.spec.script,
              interpreter: target.spec.interpreter,
              timeout_ms: target.spec.timeout_ms,
              env: target.spec.env,
              certificate: material,
            };
      run = store.queue(
        target,
        target.spec.agent_id,
        target.spec.type === "hook" ? "run" : "sync",
        config,
        actor,
        dedupe,
      );
      store.patchStatus(target.id, { state: run.state, last_run_id: run.id });
    }
    return run;
  }
  const unsubscribe = store.subscribe((run, config, update) => {
    if (
      ![
        "certificate.install",
        "hook.run",
        "certificate.inspect",
        "hook.inspect",
      ].includes(config.task)
    )
      return;
    let target: PlatformResource;
    try {
      target = store.get(run.resource_id, "certificate_target");
    } catch {
      return;
    }
    const success =
        run.state === "succeeded" &&
        (config.task.startsWith("hook.")
          ? run.result.script_sha256 === digest(config.script)
          : run.result.fingerprint_sha256 === config.fingerprint_sha256),
      version = config.certificate_version;
    const status: Record<string, any> = {
      state: success ? "applied" : run.state,
      last_run_id: run.id,
      observed_at: at(),
    };
    if (success)
      Object.assign(status, {
        applied_certificate_version: version,
        applied_revision: run.resource_revision,
        fingerprint_sha256:
          config.fingerprint_sha256 ?? config.certificate?.fingerprint_sha256,
        last_error: null,
      });
    else if (["failed", "unknown"].includes(run.state))
      status.last_error = run.result.error ?? run.state;
    store.patchStatus(target.id, status);
  });
  const controller: DomainController = {
    actions(resource) {
      return resource.kind === "credential"
        ? ["test"]
        : resource.kind === "dns_zone"
          ? [
              "sync",
              "create_record",
              "update_record",
              "delete_record",
              "set_record_status",
            ]
          : resource.kind === "acme_account"
            ? ["register"]
            : resource.kind === "certificate"
              ? [
                  "inspect",
                  "issue",
                  ...(resource.spec.source === "uploaded" ? [] : ["renew"]),
                ]
              : resource.kind === "certificate_target"
                ? ["sync", "inspect", "retry"]
                : [];
    },
    async perform(resource, action, input, actor) {
      authorize(actor);
      need(
        controller.actions(resource).includes(action),
        "unsupported_operations_action",
      );
      if (resource.kind === "credential")
        return store.run(resource, action, actor, async () => {
          const client = clientFor(options, resource.id);
          let result: any;
          if (resource.spec.provider === "aliyun")
            result = await client.request(
              "aliyun",
              "alidns",
              "DescribeDomains",
              "2015-01-09",
              { PageSize: 1 },
            );
          else if (resource.spec.provider === "tencent")
            result = await client.request(
              "tencent",
              "dnspod",
              "DescribeDomainList",
              "2021-03-23",
              { Limit: 1 },
            );
          else
            result = await client.request(
              "volcengine",
              "CDN",
              "ListCdnDomains",
              "2021-03-01",
              { PageSize: 1, PageNum: 1 },
            );
          store.patchStatus(resource.id, {
            state: "verified",
            last_test_at: at(),
          });
          return { verified: true, request_id: result.RequestId ?? "" };
        });
      if (resource.kind === "dns_zone") {
        const { client } = zoneFor(options, resource.id);
        const record = ["create_record", "update_record"].includes(action)
          ? recordInput(resource, input.record ?? input)
          : undefined;
        if (action === "create_record")
          need(!record?.id, "new_dns_record_has_id");
        if (action === "update_record")
          need(record?.id, "dns_record_id_required");
        const id = record?.id ?? String(input.id ?? input.record?.id ?? "");
        if (["delete_record", "set_record_status"].includes(action))
          need(/^[0-9]{1,30}$/.test(id), "invalid_dns_record_id");
        if (action === "set_record_status")
          need(
            typeof (input.enabled ?? input.record?.enabled) === "boolean",
            "dns_record_status_required",
          );
        return store.run(
          resource,
          action,
          actor,
          async () => {
            if (action !== "sync") {
              const previous = await client.listRecords(resource.spec.domain);
              if (action !== "create_record")
                need(
                  visibleRecords(resource, previous).some((r) => r.id === id),
                  "dns_record_outside_scope",
                );
              authorize(actor);
              if (record) {
                const remoteID = await client.writeRecord(
                  resource.spec.domain,
                  record,
                );
                if (record.enabled === false)
                  await client.setRecordStatus(
                    resource.spec.domain,
                    remoteID,
                    false,
                  );
              } else if (action === "delete_record")
                await client.deleteRecord(resource.spec.domain, id);
              else if (action === "set_record_status")
                await client.setRecordStatus(
                  resource.spec.domain,
                  id,
                  input.enabled ?? input.record.enabled,
                );
            }
            const records = visibleRecords(
              resource,
              await client.listRecords(resource.spec.domain),
            );
            const verified =
              action === "sync"
                ? true
                : record
                  ? records.some(
                      (r) =>
                        (!id || r.id === id) &&
                        r.name === record.name &&
                        r.type === record.type &&
                        r.value === record.value &&
                        (record.enabled === undefined ||
                          r.enabled === record.enabled),
                    )
                  : action === "delete_record"
                    ? !records.some((r) => r.id === id)
                    : records.some(
                        (r) =>
                          r.id === id &&
                          r.enabled ===
                            (input.enabled ?? input.record?.enabled),
                      );
            const summary = publishDNSRecords(options, resource, records);
            store.patchStatus(resource.id, {
              state: verified ? "synced" : "verifying",
            });
            return {
              ...summary,
              verified,
              state: verified ? "synced" : "verifying",
              propagation: "not_checked",
            };
          },
          undefined,
          action === "sync"
            ? {}
            : record
              ? { record }
              : {
                  id,
                  ...(action === "set_record_status"
                    ? { enabled: input.enabled ?? input.record?.enabled }
                    : {}),
                },
        );
      }
      if (resource.kind === "acme_account")
        return store.run(resource, action, actor, async () => {
          const client = await accountClient(resource, actor);
          return { verified: true, account_url: client.getAccountUrl() };
        });
      if (resource.kind === "certificate") {
        if (action === "inspect")
          return store.run(resource, action, actor, async () => {
            refreshExpiry(resource);
            const current = store.get(resource.id, "certificate");
            return { verified: true, ...current.status };
          });
        if (action === "renew")
          need(
            resource.spec.source !== "uploaded",
            "uploaded_certificate_cannot_auto_renew",
          );
        if (inFlight.has(resource.id))
          throw new HTTPError(409, "certificate_issuance_busy");
        inFlight.add(resource.id);
        try {
          const run = await store.run(resource, action, actor, () =>
            issue(resource, actor),
          );
          if (run.state === "succeeded") await distribute(resource.id);
          else
            store.patchStatus(resource.id, {
              state: run.state,
              last_error:
                run.result.code ??
                run.result.error ??
                "certificate_issuance_failed",
            });
          return run;
        } finally {
          inFlight.delete(resource.id);
        }
      }
      if (action === "inspect") {
        const material = getCertificateMaterial(
          store,
          resource.spec.certificate_id,
        );
        if (resource.spec.type === "cloud") {
          const run = await store.run(resource, "inspect", actor, () =>
            inspectCloudCertificate(options, resource, material, actor),
          );
          const applied =
            run.state === "succeeded" && run.result.verified === true;
          store.patchStatus(resource.id, {
            state: applied ? "applied" : run.state,
            last_run_id: run.id,
            domains: run.result.domains ?? [],
            observed_at: at(),
            ...(applied
              ? {
                  applied_certificate_version: material.certificate_version,
                  applied_revision: resource.revision,
                  fingerprint_sha256: material.fingerprint_sha256,
                }
              : {}),
          });
          return run;
        }
        const prior = store
          .actions(resource.id)
          .find(
            (r) =>
              r.action !== "inspect" &&
              r.resource_revision === resource.revision,
          );
        need(prior, "certificate_target_has_no_execution");
        const config = {
          ...resource.spec,
          task:
            resource.spec.type === "hook"
              ? "hook.inspect"
              : "certificate.inspect",
          hook_id: resource.id,
          original_operation_id: prior.id,
          certificate_id: resource.spec.certificate_id,
          certificate_version: material.certificate_version,
          fingerprint_sha256: material.fingerprint_sha256,
          script_sha256:
            resource.spec.type === "hook"
              ? digest(resource.spec.script)
              : undefined,
        };
        return store.queue(
          resource,
          resource.spec.agent_id,
          "inspect",
          config,
          actor,
        );
      }
      return syncTarget(resource, actor, action === "retry");
    },
    async tick() {
      const dueZones = store
        .list("dns_zone")
        .filter(
          (zone) =>
            store.authorized(zone.authorized_by) &&
            deps.now().getTime() -
              Math.max(
                Date.parse(zone.status.last_sync_at ?? "") || 0,
                Date.parse(zone.status.last_sync_attempt_at ?? "") || 0,
              ) >=
              300000,
        )
        .slice(0, 10);
      for (const zone of dueZones) {
        store.patchStatus(zone.id, { last_sync_attempt_at: at() });
        const run = await controller.perform(
          zone,
          "sync",
          {},
          zone.authorized_by,
        );
        if (run.state !== "succeeded")
          store.patchStatus(zone.id, {
            state: run.state,
            last_error: run.result.code ?? "dns_sync_failed",
          });
      }
      for (const certificate of store.list("certificate")) {
        refreshExpiry(certificate);
        const current = store.get(certificate.id, "certificate");
        if (
          current.spec.auto_renew &&
          current.status.certificate_version &&
          current.status.renewal_due &&
          store.authorized(current.authorized_by) &&
          !inFlight.has(current.id)
        ) {
          inFlight.add(current.id);
          try {
            const key =
                "certificate-renew:" +
                current.id +
                ":" +
                current.revision +
                ":" +
                current.status.certificate_version,
              run = await store.run(
                current,
                "renew",
                current.authorized_by,
                () => issue(current, current.authorized_by),
                key,
              );
            if (run.state !== "succeeded")
              store.patchStatus(current.id, {
                state: run.state,
                last_error:
                  run.result.code ??
                  run.result.error ??
                  "certificate_renewal_failed",
              });
          } finally {
            inFlight.delete(current.id);
          }
        }
        await distribute(certificate.id);
      }
      for (const order of db.all<any>(
        "SELECT * FROM ops_acme_orders WHERE state IN ('complete','saved')",
      )) {
        let certificate: PlatformResource;
        try {
          certificate = store.get(order.certificate_id, "certificate");
        } catch {
          continue;
        }
        if (store.authorized(certificate.authorized_by))
          await cleanChallenges(order.id, certificate.authorized_by);
      }
    },
    close: unsubscribe,
  };
  function refreshExpiry(certificate: PlatformResource): void {
    const expires = Date.parse(certificate.status.expires_at ?? "");
    if (!Number.isFinite(expires)) return;
    const remaining = Math.floor((expires - deps.now().getTime()) / 86400000),
      renewAfter = Date.parse(certificate.status.renew_after ?? "");
    store.patchStatus(certificate.id, {
      days_remaining: remaining,
      expired: expires <= deps.now().getTime(),
      expiry_warning: remaining <= certificate.spec.renew_before_days,
      renewal_due:
        certificate.spec.source !== "uploaded" &&
        deps.now().getTime() >= renewAfter,
      checked_at: at(),
    });
  }
  async function distribute(certificateID: string): Promise<void> {
    const certificate = store.get(certificateID, "certificate");
    if (!certificate.status.certificate_version) return;
    const summaries = [];
    for (const target of store
      .list("certificate_target")
      .filter((t) => t.spec.certificate_id === certificateID)) {
      if (
        target.spec.enabled &&
        store.authorized(target.authorized_by) &&
        !(
          target.status.applied_certificate_version ===
            certificate.status.certificate_version &&
          target.status.applied_revision === target.revision
        )
      ) {
        try {
          await syncTarget(target, target.authorized_by, false, true);
        } catch (error) {
          store.patchStatus(target.id, {
            state: (error as any).state ?? "failed",
            last_error: safeError(error),
          });
        }
      }
      const fresh = store.get(target.id, "certificate_target");
      summaries.push({
        id: fresh.id,
        name: fresh.name,
        type: fresh.spec.type,
        enabled: fresh.spec.enabled,
        ...fresh.status,
      });
    }
    store.patchStatus(certificateID, { targets: summaries });
  }
  return controller;
}
