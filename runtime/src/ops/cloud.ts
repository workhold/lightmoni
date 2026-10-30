import {
  createHash,
  createHmac,
  randomUUID,
  X509Certificate,
} from "node:crypto";
import { resolve4, resolve6, resolveTxt } from "node:dns/promises";
import { HTTPError } from "../shared/http.js";
import { integerString, parseJSON, stringifyJSON } from "../shared/json.js";
import type { PlatformOptions, PlatformResource } from "./types.js";

export type CloudProvider = "aliyun" | "tencent" | "volcengine";
export interface CloudCredential {
  provider: CloudProvider;
  access_key_id: string;
  access_key_secret: string;
  session_token?: string;
}
export interface DNSRecord {
  id: string;
  name: string;
  type: string;
  value: string;
  ttl: number;
  line?: string;
  line_id?: string;
  priority?: number;
  weight?: number;
  weighted?: boolean;
  enabled: boolean;
}
export interface DNSInput {
  id?: string;
  name: string;
  type: string;
  value: string;
  ttl?: number;
  line?: string;
  line_id?: string;
  priority?: number;
  weight?: number;
  enabled?: boolean;
}
export class CloudError extends Error {
  state?: string;
  constructor(
    public code: string,
    public request_id = "",
    unknown = false,
  ) {
    super(code);
    this.name = "CloudError";
    if (unknown) this.state = "unknown";
  }
}
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const hmac = (key: string | Buffer, value: string) =>
  createHmac("sha256", key).update(value).digest();
const percent = (value: string) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
function need(condition: unknown, code: string): asserts condition {
  if (!condition) throw new HTTPError(400, code);
}
export function normalizeDomain(input: unknown, wildcard = false): string {
  need(typeof input === "string", "invalid_domain");
  const domain = input.trim().toLowerCase().replace(/\.$/, "");
  const name = wildcard && domain.startsWith("*.") ? domain.slice(2) : domain;
  need(
    name.length <= 253 &&
      name.includes(".") &&
      name
        .split(".")
        .every((p) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(p)),
    "invalid_domain",
  );
  return wildcard && domain.startsWith("*.") ? "*." + name : name;
}
export function validateCredential(
  input: Record<string, any>,
  previous?: Record<string, any>,
): Record<string, any> {
  const provider = input.provider;
  need(
    ["aliyun", "tencent", "volcengine"].includes(provider),
    "invalid_cloud_provider",
  );
  const out: Record<string, any> = { provider };
  for (const key of ["access_key_id", "access_key_secret", "session_token"]) {
    const value =
      input[key] === undefined || input[key] === ""
        ? (previous?.[key] ?? "")
        : input[key];
    need(
      typeof value === "string" &&
        value.length <= 4096 &&
        !/[\r\n\0]/.test(value),
      "invalid_cloud_credential",
    );
    if (key !== "session_token")
      need(value.length > 0, "cloud_credential_required");
    if (value) out[key] = value;
  }
  return out;
}
export function publicCredential(
  spec: Record<string, any>,
): Record<string, any> {
  return {
    provider: spec.provider,
    has_access_key_id: !!spec.access_key_id,
    has_access_key_secret: !!spec.access_key_secret,
    has_session_token: !!spec.session_token,
  };
}

/** API requests always use fixed provider endpoints. Secrets are never put in a URL. */
export class CloudClient {
  constructor(
    readonly credential: CloudCredential,
    readonly fetcher: typeof fetch = fetch,
    readonly now: () => Date = () => new Date(),
  ) {}
  async request(
    provider: CloudProvider,
    service: string,
    action: string,
    version: string,
    input: Record<string, any>,
    write = false,
  ): Promise<any> {
    if (provider !== this.credential.provider)
      throw new CloudError("credential_provider_mismatch");
    let url: string, body: string, headers: Record<string, string>;
    const now = this.now(),
      cred = this.credential;
    if (provider === "aliyun") {
      const endpoints: Record<string, string> = {
        alidns: "alidns.aliyuncs.com",
        cdn: "cdn.aliyuncs.com",
        cas: "cas.aliyuncs.com",
      };
      const host = endpoints[service];
      if (!host) throw new CloudError("unsupported_cloud_service");
      const params: Record<string, string> = {
        Action: action,
        Version: version,
        Format: "JSON",
        AccessKeyId: cred.access_key_id,
        SignatureMethod: "HMAC-SHA1",
        SignatureVersion: "1.0",
        SignatureNonce: randomUUID(),
        Timestamp: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
      };
      if (cred.session_token) params.SecurityToken = cred.session_token;
      for (const [k, v] of Object.entries(input))
        if (v !== undefined && v !== null) params[k] = String(v);
      const canonical = Object.keys(params)
        .sort()
        .map((k) => percent(k) + "=" + percent(params[k]))
        .join("&");
      params.Signature = createHmac("sha1", cred.access_key_secret + "&")
        .update("POST&%2F&" + percent(canonical))
        .digest("base64");
      body = new URLSearchParams(params).toString();
      url = "https://" + host + "/";
      headers = { "content-type": "application/x-www-form-urlencoded" };
    } else if (provider === "tencent") {
      if (!["dnspod", "ssl", "cdn"].includes(service))
        throw new CloudError("unsupported_cloud_service");
      const host = service + ".tencentcloudapi.com",
        date = now.toISOString().slice(0, 10),
        timestamp = Math.floor(now.getTime() / 1000),
        scope = date + "/" + service + "/tc3_request";
      body = stringifyJSON(input);
      const canonical =
        "POST\n/\n\ncontent-type:application/json; charset=utf-8\nhost:" +
        host +
        "\n\ncontent-type;host\n" +
        hash(body);
      const signing = hmac(
        hmac(hmac("TC3" + cred.access_key_secret, date), service),
        "tc3_request",
      );
      const signature = hmac(
        signing,
        "TC3-HMAC-SHA256\n" + timestamp + "\n" + scope + "\n" + hash(canonical),
      ).toString("hex");
      url = "https://" + host + "/";
      headers = {
        "content-type": "application/json; charset=utf-8",
        "x-tc-action": action,
        "x-tc-version": version,
        "x-tc-timestamp": String(timestamp),
        authorization:
          "TC3-HMAC-SHA256 Credential=" +
          cred.access_key_id +
          "/" +
          scope +
          ", SignedHeaders=content-type;host, Signature=" +
          signature,
      };
      if (cred.session_token) headers["x-tc-token"] = cred.session_token;
    } else {
      if (service !== "CDN") throw new CloudError("unsupported_cloud_service");
      const host = "cdn.volcengineapi.com",
        date = now.toISOString().replace(/[-:]|\.\d{3}/g, ""),
        day = date.slice(0, 8),
        scope = day + "/cn-north-1/CDN/request";
      body = JSON.stringify(input);
      const query =
          "Action=" + percent(action) + "&Version=" + percent(version),
        digest = hash(body);
      headers = {
        "content-type": "application/json",
        host: host,
        "x-date": date,
        "x-content-sha256": digest,
      };
      if (cred.session_token) headers["x-security-token"] = cred.session_token;
      const names = Object.keys(headers)
          .filter((k) => k !== "content-type")
          .sort(),
        signed = names.join(";");
      const canonical =
        "POST\n/\n" +
        query +
        "\n" +
        names.map((k) => k + ":" + headers[k].trim() + "\n").join("") +
        "\n" +
        signed +
        "\n" +
        digest;
      const signing = hmac(
        hmac(hmac(hmac(cred.access_key_secret, day), "cn-north-1"), "CDN"),
        "request",
      );
      headers.authorization =
        "HMAC-SHA256 Credential=" +
        cred.access_key_id +
        "/" +
        scope +
        ", SignedHeaders=" +
        signed +
        ", Signature=" +
        hmac(
          signing,
          "HMAC-SHA256\n" + date + "\n" + scope + "\n" + hash(canonical),
        ).toString("hex");
      url = "https://" + host + "/?" + query;
    }
    let response: Response;
    try {
      response = await this.fetcher(url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(30_000),
        redirect: "error",
      });
    } catch {
      throw new CloudError(
        write ? "cloud_result_unknown" : "cloud_request_failed",
        "",
        write,
      );
    }
    let result: any;
    try {
      const text = await response.text();
      if (text.length > 8_000_000) throw Error();
      result = parseJSON(text);
    } catch {
      throw new CloudError(
        write ? "cloud_result_unknown" : "cloud_invalid_response",
        "",
        write,
      );
    }
    const error =
      provider === "aliyun"
        ? result.Code
          ? { Code: result.Code }
          : null
        : provider === "tencent"
          ? result.Response?.Error
          : result.ResponseMetadata?.Error;
    const requestID = String(
      result.RequestId ??
        result.Response?.RequestId ??
        result.ResponseMetadata?.RequestId ??
        "",
    ).slice(0, 256);
    if (error) {
      // Only expose provider error codes, never a message that may echo PEM or request values.
      const code = /^[A-Za-z0-9_.-]{1,180}$/.test(error.Code)
        ? error.Code
        : "cloud_api_error";
      const out = new CloudError(code, requestID);
      if (
        provider === "volcengine" &&
        code === "InvalidParameter.Certificate.Duplicated"
      ) {
        const match = String(error.Message ?? "").match(
          /\b(cert[-_][a-zA-Z0-9-]+)\b/,
        );
        if (match) (out as any).certificate_id = match[1];
      }
      throw out;
    }
    if (!response.ok)
      throw new CloudError(
        write && response.status >= 500
          ? "cloud_result_unknown"
          : "cloud_http_" + response.status,
        requestID,
        write && response.status >= 500,
      );
    if (provider === "tencent") {
      if (!result.Response) throw new CloudError("cloud_invalid_response");
      return result.Response;
    }
    if (provider === "volcengine") {
      if (!result.ResponseMetadata)
        throw new CloudError("cloud_invalid_response");
      return result.Result ?? {};
    }
    return result;
  }
  async listRecords(domain: string): Promise<DNSRecord[]> {
    const records: DNSRecord[] = [];
    for (let page = 0; page < 1000; page++) {
      if (this.credential.provider === "aliyun") {
        const result = await this.request(
          "aliyun",
          "alidns",
          "DescribeDomainRecords",
          "2015-01-09",
          { DomainName: domain, PageNumber: page + 1, PageSize: 500 },
        );
        const items = result.DomainRecords?.Record ?? [];
        if (!Array.isArray(items))
          throw new CloudError("cloud_invalid_response");
        records.push(
          ...items.map((r: any) => ({
            id: integerString(r.RecordId),
            name: r.RR,
            type: r.Type,
            value: r.Value,
            ttl: Number(r.TTL),
            line: r.Line,
            priority: r.Priority === undefined ? undefined : Number(r.Priority),
            weight: r.Weight == null ? undefined : Number(r.Weight),
            weighted: r.LbaStatus === true || r.LbaStatus === "true",
            enabled: String(r.Status).toUpperCase() === "ENABLE",
          })),
        );
        if (
          records.length >= Number(result.TotalCount ?? records.length) ||
          items.length === 0
        )
          return records;
      } else if (this.credential.provider === "tencent") {
        const result = await this.request(
          "tencent",
          "dnspod",
          "DescribeRecordList",
          "2021-03-23",
          {
            Domain: domain,
            Offset: page * 500,
            Limit: 500,
            ErrorOnEmpty: "no",
          },
        );
        const items = result.RecordList ?? [];
        if (!Array.isArray(items))
          throw new CloudError("cloud_invalid_response");
        records.push(
          ...items.map((r: any) => ({
            id: integerString(r.RecordId),
            name: r.Name,
            type: r.Type,
            value: r.Value,
            ttl: Number(r.TTL),
            line: r.Line,
            line_id: r.LineId,
            priority: r.MX === undefined ? undefined : Number(r.MX),
            weight: r.Weight == null ? undefined : Number(r.Weight),
            enabled: String(r.Status).toUpperCase() === "ENABLE",
          })),
        );
        if (items.length < 500) return records;
      } else throw new CloudError("dns_provider_not_supported");
    }
    throw new CloudError("dns_record_limit_exceeded");
  }
  async writeRecord(domain: string, record: DNSInput): Promise<string> {
    if (this.credential.provider === "aliyun") {
      const r = await this.request(
        "aliyun",
        "alidns",
        record.id ? "UpdateDomainRecord" : "AddDomainRecord",
        "2015-01-09",
        {
          ...(record.id ? { RecordId: record.id } : { DomainName: domain }),
          RR: record.name,
          Type: record.type,
          Value: record.value,
          TTL: record.ttl ?? 600,
          Line: record.line ?? "default",
          Priority: record.priority,
        },
        true,
      );
      const id = String(r.RecordId ?? record.id ?? "");
      if (record.weight !== undefined)
        await this.setWeight(domain, { ...record, id });
      return id;
    }
    const r = await this.request(
      "tencent",
      "dnspod",
      record.id ? "ModifyRecord" : "CreateRecord",
      "2021-03-23",
      {
        Domain: domain,
        ...(record.id ? { RecordId: parseJSON(record.id) } : {}),
        SubDomain: record.name,
        RecordType: record.type,
        RecordLine: record.line ?? "默认",
        RecordLineId: record.line_id,
        Value: record.value,
        TTL: record.ttl ?? 600,
        MX: record.priority,
        Weight: record.weight,
      },
      true,
    );
    return integerString(r.RecordId ?? record.id ?? "");
  }
  async setWeight(
    domain: string,
    record: DNSInput,
    authorize: () => boolean = () => true,
  ): Promise<void> {
    if (this.credential.provider !== "aliyun" || record.weight === undefined)
      return;
    if (!authorize())
      throw new HTTPError(403, "operations_authorization_revoked");
    await this.request(
      "aliyun",
      "alidns",
      "SetDNSSLBStatus",
      "2015-01-09",
      {
        DomainName: domain,
        SubDomain: record.name + "." + domain,
        Type: record.type,
        Line: record.line ?? "default",
        Open: true,
      },
      true,
    );
    if (!authorize())
      throw new HTTPError(403, "operations_authorization_revoked");
    await this.request(
      "aliyun",
      "alidns",
      "UpdateDNSSLBWeight",
      "2015-01-09",
      { RecordId: record.id, Weight: record.weight },
      true,
    );
  }
  async dnsLines(
    domain: string,
  ): Promise<{
    provider: string;
    lines: { id: string; name: string }[];
    weight: { min: number; max: number };
    verification: string;
  }> {
    const lines: { id: string; name: string }[] = [];
    if (this.credential.provider === "aliyun") {
      const r = await this.request(
        "aliyun",
        "alidns",
        "DescribeDomainInfo",
        "2015-01-09",
        { DomainName: domain, NeedDetailAttributes: true },
      );
      for (const l of r.RecordLines?.RecordLine ?? [])
        lines.push({
          id: l.LineCode,
          name: l.LineDisplayName ?? l.LineName ?? l.LineCode,
        });
      if (!lines.some((l) => l.id === "default"))
        lines.unshift({ id: "default", name: "默认" });
    } else if (this.credential.provider === "tencent") {
      const r = await this.request(
        "tencent",
        "dnspod",
        "DescribeRecordLineCategoryList",
        "2021-03-23",
        { Domain: domain },
      );
      const walk = (items: any[]) => {
        for (const l of items) {
          if (l.Useful === true)
            lines.push({ id: String(l.LineId), name: l.LineName });
          walk(l.SubGroup ?? []);
        }
      };
      walk(r.LineList ?? []);
    } else throw new CloudError("dns_provider_not_supported");
    if (!lines.length) throw new CloudError("dns_capability_unavailable");
    return {
      provider: this.credential.provider,
      lines,
      weight: { min: 1, max: 100 },
      verification: "provider_required",
    };
  }
  async deleteRecord(domain: string, id: string): Promise<void> {
    if (this.credential.provider === "aliyun")
      await this.request(
        "aliyun",
        "alidns",
        "DeleteDomainRecord",
        "2015-01-09",
        { RecordId: id },
        true,
      );
    else
      await this.request(
        "tencent",
        "dnspod",
        "DeleteRecord",
        "2021-03-23",
        { Domain: domain, RecordId: parseJSON(id) },
        true,
      );
  }
  async setRecordStatus(
    domain: string,
    id: string,
    enabled: boolean,
  ): Promise<void> {
    if (this.credential.provider === "aliyun")
      await this.request(
        "aliyun",
        "alidns",
        "SetDomainRecordStatus",
        "2015-01-09",
        { RecordId: id, Status: enabled ? "Enable" : "Disable" },
        true,
      );
    else
      await this.request(
        "tencent",
        "dnspod",
        "ModifyRecordStatus",
        "2021-03-23",
        {
          Domain: domain,
          RecordId: parseJSON(id),
          Status: enabled ? "ENABLE" : "DISABLE",
        },
        true,
      );
  }
}
export function clientFor(
  options: PlatformOptions,
  credentialID: string,
): CloudClient {
  const resource = options.store.get(credentialID, "credential");
  return new CloudClient(
    resource.spec as CloudCredential,
    options.fetch ?? fetch,
    options.deps.now,
  );
}
export function zoneFor(
  options: PlatformOptions,
  zoneID: string,
): { zone: PlatformResource; client: CloudClient } {
  const zone = options.store.get(zoneID, "dns_zone");
  return { zone, client: clientFor(options, zone.spec.credential_id) };
}
export function recordInput(
  zone: PlatformResource,
  input: Record<string, any>,
): DNSInput {
  let name = String(input.name ?? "@")
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");
  const domain = zone.spec.domain;
  if (name === domain) name = "@";
  else if (name.endsWith("." + domain))
    name = name.slice(0, -domain.length - 1);
  need(
    name === "@" ||
      name === "*" ||
      name
        .split(".")
        .every(
          (p) =>
            p === "*" || /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/.test(p),
        ),
    "invalid_dns_record_name",
  );
  const fqdn = name === "@" ? domain : name + "." + domain,
    scope = zone.spec.scope ?? domain;
  need(
    fqdn === scope || fqdn.endsWith("." + scope),
    "dns_record_outside_scope",
  );
  const type = String(input.type ?? "").toUpperCase();
  need(
    [
      "A",
      "AAAA",
      "CNAME",
      "TXT",
      "MX",
      "NS",
      "CAA",
      "SRV",
      "HTTPS",
      "SVCB",
      "SPF",
    ].includes(type),
    "invalid_dns_record_type",
  );
  need(
    typeof input.value === "string" &&
      input.value.length > 0 &&
      input.value.length <= 4096 &&
      !/[\r\n\0]/.test(input.value),
    "invalid_dns_record_value",
  );
  const ttl = input.ttl ?? 600;
  need(Number.isInteger(ttl) && ttl >= 1 && ttl <= 604800, "invalid_dns_ttl");
  if (input.priority !== undefined)
    need(
      Number.isInteger(input.priority) &&
        input.priority >= 0 &&
        input.priority <= 65535,
      "invalid_dns_priority",
    );
  if (input.weight !== undefined)
    need(
      Number.isInteger(input.weight) &&
        input.weight >= 1 &&
        input.weight <= 100,
      "invalid_dns_weight",
    );
  if (input.id !== undefined)
    need(/^[0-9]{1,30}$/.test(String(input.id)), "invalid_dns_record_id");
  for (const field of ["line", "line_id"])
    if (input[field] !== undefined)
      need(
        typeof input[field] === "string" &&
          input[field].length < 100 &&
          !/[\r\n\0]/.test(input[field]),
        "invalid_dns_line",
      );
  return {
    id: input.id === undefined ? undefined : String(input.id),
    name,
    type,
    value: input.value,
    ttl,
    line: input.line,
    line_id: input.line_id,
    priority: input.priority,
    weight: input.weight,
    enabled: input.enabled,
  };
}
export function visibleRecords(
  zone: PlatformResource,
  records: DNSRecord[],
): DNSRecord[] {
  return records.filter((r) => {
    const name =
      r.name === "@" ? zone.spec.domain : r.name + "." + zone.spec.domain;
    return name === zone.spec.scope || name.endsWith("." + zone.spec.scope);
  });
}
export function initDNSSchema(options: PlatformOptions): void {
  options.deps.db
    .exec(`CREATE TABLE IF NOT EXISTS ops_dns_owned(id TEXT PRIMARY KEY,zone_id TEXT NOT NULL,owner_id TEXT NOT NULL,record_id TEXT NOT NULL DEFAULT '',name TEXT NOT NULL,type TEXT NOT NULL,value TEXT NOT NULL,ttl INTEGER NOT NULL,state TEXT NOT NULL,updated_at TEXT NOT NULL); CREATE INDEX IF NOT EXISTS ops_dns_owned_owner ON ops_dns_owned(zone_id,owner_id);
    CREATE TABLE IF NOT EXISTS ops_dns_observed(zone_id TEXT NOT NULL,record_id TEXT NOT NULL,name TEXT NOT NULL,type TEXT NOT NULL,value TEXT NOT NULL,record_json TEXT NOT NULL,PRIMARY KEY(zone_id,record_id));`);
  const fields = options.deps.db.all<any>("PRAGMA table_info(ops_dns_owned)");
  if (!fields.some((f) => f.name === "line"))
    options.deps.db.exec(
      "ALTER TABLE ops_dns_owned ADD COLUMN line TEXT NOT NULL DEFAULT ''",
    );
  if (!fields.some((f) => f.name === "weight"))
    options.deps.db.exec("ALTER TABLE ops_dns_owned ADD COLUMN weight INTEGER");
}
export function publishDNSRecords(
  options: PlatformOptions,
  zone: PlatformResource,
  records: DNSRecord[],
): Record<string, any> {
  const { db } = options.deps,
    visible = visibleRecords(zone, records),
    owned = db.all<any>(
      "SELECT record_id,owner_id FROM ops_dns_owned WHERE zone_id=?",
      zone.id,
    );
  const annotated = visible.map((record) => ({
    ...record,
    managed_by: owned
      .filter((o) => o.record_id === record.id)
      .map((o) => o.owner_id),
  }));
  db.transaction(() => {
    db.run("DELETE FROM ops_dns_observed WHERE zone_id=?", zone.id);
    for (const record of annotated)
      db.run(
        "INSERT INTO ops_dns_observed VALUES(?,?,?,?,?,?)",
        zone.id,
        record.id,
        record.name,
        record.type,
        record.value,
        JSON.stringify(record),
      );
  });
  const summary = {
    records: annotated.slice(0, 100),
    record_count: annotated.length,
    records_limit: 100,
    last_sync_at: options.deps.now().toISOString(),
    propagation: "not_checked",
  };
  options.store.patchStatus(zone.id, summary);
  return summary;
}
/** Reconcile only records journalled for this owner. Existing user records are never removed or adopted. */
export async function ensureDnsRecords(
  options: PlatformOptions,
  zoneID: string,
  ownerID: string,
  inputs: DNSInput[],
  actor: string,
): Promise<Record<string, any>> {
  if (!options.store.authorized(actor))
    throw new HTTPError(403, "operations_authorization_revoked");
  initDNSSchema(options);
  const { zone, client } = zoneFor(options, zoneID),
    db = options.deps.db,
    at = () => options.deps.now().toISOString();
  const lineKey = (r: { line?: string; line_id?: string }) => {
    const value = r.line_id ?? r.line ?? "";
    return ["", "default", "默认", "0"].includes(value) ? "" : value;
  };
  const desired = inputs.map((r) => recordInput(zone, r));
  // Preflight every requested line before removing any currently serving record.
  if (desired.some((r) => r.weight !== undefined || lineKey(r))) {
    const capability = await client.dnsLines(zone.spec.domain);
    for (const record of desired) {
      const key = lineKey(record),
        line = capability.lines.find(
          (l) => lineKey({ line: l.id }) === key || l.name === record.line,
        );
      if (!line) throw new CloudError("dns_line_not_supported");
      if (client.credential.provider === "tencent") {
        record.line_id = line.id;
        record.line = line.name;
      } else record.line = line.id;
    }
  }
  const identity = (r: {
    name: string;
    type: string;
    value: string;
    line?: string;
    line_id?: string;
  }) => [r.name, r.type, r.value, lineKey(r)].join("\0");
  const observed = await client.listRecords(zone.spec.domain);
  const owned = db.all<any>(
    "SELECT * FROM ops_dns_owned WHERE zone_id=? AND owner_id=?",
    zoneID,
    ownerID,
  );
  for (const row of owned) {
    if (row.state === "unknown" || (row.state === "creating" && !row.record_id))
      throw new CloudError("dns_ownership_unknown", "", true);
    const current = observed.find((r) => r.id === row.record_id);
    if (
      current &&
      (identity(current) !== identity(row) ||
        (row.state === "applied" &&
          (current.ttl !== row.ttl ||
            (row.weight != null && current.weight !== row.weight))))
    )
      throw new CloudError("dns_owned_record_modified_externally");
  }
  for (const record of desired) {
    const conflict = observed.find(
      (r) =>
        r.name === record.name &&
        (record.type === "CNAME" ? r.type !== "CNAME" : r.type === "CNAME") &&
        !owned.some((o) => o.record_id === r.id),
    );
    if (conflict) throw new CloudError("dns_record_conflict");
    if (
      record.weight !== undefined &&
      observed.some(
        (r) =>
          r.name === record.name &&
          r.type === record.type &&
          lineKey(r) === lineKey(record) &&
          identity(r) !== identity(record) &&
          !owned.some((o) => o.record_id === r.id),
      )
    )
      throw new CloudError("dns_record_conflict");
    const external = observed.find(
      (r) =>
        identity(r) === identity(record) &&
        !owned.some((o) => o.record_id === r.id),
    );
    if (
      external &&
      (!external.enabled ||
        external.ttl !== record.ttl ||
        (record.weight !== undefined &&
          (external.weight !== record.weight ||
            (client.credential.provider === "aliyun" && !external.weighted))))
    )
      throw new CloudError("dns_record_conflict");
  }
  for (const row of owned) {
    if (desired.some((r) => identity(r) === identity(row))) continue;
    if (observed.some((r) => r.id === row.record_id)) {
      if (!options.store.authorized(actor))
        throw new HTTPError(403, "operations_authorization_revoked");
      await client.deleteRecord(zone.spec.domain, row.record_id);
    }
    db.run("DELETE FROM ops_dns_owned WHERE id=?", row.id);
  }
  for (const record of desired) {
    const row = owned.find((o) => identity(o) === identity(record));
    const existing = observed.find((r) => identity(r) === identity(record));
    if (existing && !row) continue; // External records remain external.
    // Providers can delay indexing a successful creation. Never create a second
    // record while its durable record ID is awaiting observation.
    if (row?.record_id && !existing && depsAge(row.updated_at) < 30000)
      continue;
    const key = row?.id ?? hash([zoneID, ownerID, identity(record)].join("\0"));
    const differs =
      !existing ||
      !existing.enabled ||
      existing.ttl !== record.ttl ||
      (record.weight !== undefined &&
        (existing.weight !== record.weight ||
          (client.credential.provider === "aliyun" && !existing.weighted)));
    if (!differs) continue;
    if (!options.store.authorized(actor))
      throw new HTTPError(403, "operations_authorization_revoked");
    db.run(
      "INSERT OR REPLACE INTO ops_dns_owned(id,zone_id,owner_id,record_id,name,type,value,ttl,state,updated_at,line,weight) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      key,
      zoneID,
      ownerID,
      existing?.id ?? "",
      record.name,
      record.type,
      record.value,
      record.ttl,
      "creating",
      at(),
      lineKey(record),
      record.weight ?? null,
    );
    let remote = existing?.id;
    try {
      // Journal the new record ID before the separate Aliyun SLB calls. A failed
      // weight call must never orphan a created DNS record or trigger duplication.
      remote = await client.writeRecord(zone.spec.domain, {
        ...record,
        id: existing?.id,
        ...(client.credential.provider === "aliyun"
          ? { weight: undefined }
          : {}),
      });
      if (!remote) throw new CloudError("dns_record_id_missing", "", true);
      db.run(
        "UPDATE ops_dns_owned SET record_id=?,state='verifying',updated_at=? WHERE id=?",
        remote,
        at(),
        key,
      );
      if (
        client.credential.provider === "aliyun" &&
        record.weight !== undefined
      )
        await client.setWeight(
          zone.spec.domain,
          { ...record, id: remote },
          () => options.store.authorized(actor),
        );
      if (existing && !existing.enabled) {
        if (!options.store.authorized(actor))
          throw new HTTPError(403, "operations_authorization_revoked");
        await client.setRecordStatus(zone.spec.domain, remote, true);
      }
    } catch (error) {
      db.run(
        "UPDATE ops_dns_owned SET record_id=?,state=?,updated_at=? WHERE id=?",
        remote ?? "",
        remote
          ? "verifying"
          : (error as any).state === "unknown"
            ? "unknown"
            : "failed",
        at(),
        key,
      );
      throw error;
    }
  }
  function depsAge(value: string) {
    return options.deps.now().getTime() - Date.parse(value);
  }
  const current = await client.listRecords(zone.spec.domain);
  const verified =
    desired.every((record) =>
      current.some(
        (r) =>
          identity(r) === identity(record) &&
          r.enabled &&
          r.ttl === record.ttl &&
          (record.weight === undefined ||
            (r.weight === record.weight &&
              (client.credential.provider !== "aliyun" || r.weighted))),
      ),
    ) &&
    owned
      .filter((row) => !desired.some((r) => identity(r) === identity(row)))
      .every((row) => !current.some((r) => r.id === row.record_id));
  if (verified)
    db.run(
      "UPDATE ops_dns_owned SET state='applied' WHERE zone_id=? AND owner_id=? AND state='verifying'",
      zoneID,
      ownerID,
    );
  return {
    ...publishDNSRecords(options, zone, current),
    verified,
    propagation: "not_checked",
  };
}

export async function dnsPropagation(
  domain: string,
  type: string,
  value: string,
): Promise<boolean> {
  try {
    if (type === "TXT")
      return (await resolveTxt(domain)).some(
        (parts) => parts.join("") === value,
      );
    if (type === "A") return (await resolve4(domain)).includes(value);
    if (type === "AAAA") return (await resolve6(domain)).includes(value);
  } catch {}
  return false;
}

export interface CloudCertificate {
  certificate_pem: string;
  private_key_pem: string;
  fingerprint_sha256: string;
  certificate_version: string;
}
export function initCloudSchema(options: PlatformOptions): void {
  options.deps.db.exec(
    `CREATE TABLE IF NOT EXISTS ops_cloud_certificates(id TEXT PRIMARY KEY,credential_id TEXT NOT NULL,fingerprint TEXT NOT NULL,provider_certificate_id TEXT NOT NULL,state TEXT NOT NULL,updated_at TEXT NOT NULL);`,
  );
}
/** An explicit observation can resolve an ambiguous bind without replaying any cloud mutation. */
export async function inspectCloudCertificate(
  options: PlatformOptions,
  target: PlatformResource,
  material: CloudCertificate,
  actor: string,
): Promise<Record<string, any>> {
  if (!options.store.authorized(actor))
    throw new HTTPError(403, "operations_authorization_revoked");
  initCloudSchema(options);
  const client = clientFor(options, target.spec.credential_id),
    provider = client.credential.provider,
    mapID = hash(
      provider +
        "\0" +
        client.credential.access_key_id +
        "\0" +
        target.spec.credential_id +
        "\0" +
        material.fingerprint_sha256,
    ),
    remote = options.deps.db.get<any>(
      "SELECT provider_certificate_id FROM ops_cloud_certificates WHERE id=?",
      mapID,
    )?.provider_certificate_id;
  const results = [];
  const matches = (pem: any) => {
    try {
      return (
        new X509Certificate(pem).fingerprint256 === material.fingerprint_sha256
      );
    } catch {
      return false;
    }
  };
  for (const domain of target.spec.domains as string[]) {
    if (!options.store.authorized(actor))
      throw new HTTPError(403, "operations_authorization_revoked");
    if (provider === "aliyun") {
      const response = await client.request(
          "aliyun",
          "cdn",
          "DescribeDomainCertificateInfo",
          "2018-05-10",
          { DomainName: domain },
        ),
        info = response.CertInfos?.CertInfo?.find(
          (r: any) => r.DomainName === domain,
        );
      results.push({
        domain,
        verified:
          info?.ServerCertificateStatus === "on" &&
          (!info?.Status || info.Status === "success") &&
          matches(info?.ServerCertificate),
        provider_certificate_id: info?.CertId ?? "",
      });
    } else if (provider === "tencent") {
      const response = await client.request(
          "tencent",
          "cdn",
          "DescribeDomainsConfig",
          "2018-06-06",
          {
            Filters: [{ Name: "domain", Value: [domain], Fuzzy: false }],
            Limit: 100,
          },
        ),
        info = response.Domains?.find((r: any) => r.Domain === domain),
        cert = info?.Https?.CertInfo;
      results.push({
        domain,
        verified:
          info?.Https?.Switch === "on" &&
          info?.Https?.SslStatus === "deployed" &&
          (remote ? cert?.CertId === remote : matches(cert?.Certificate)),
        provider_certificate_id: cert?.CertId ?? "",
      });
    } else {
      const response = await client.request(
          "volcengine",
          "CDN",
          "DescribeCdnConfig",
          "2021-03-01",
          { Domain: domain },
        ),
        https = response.DomainConfig?.HTTPS,
        cert = https?.CertInfo;
      results.push({
        domain,
        verified:
          https?.Switch === true &&
          (remote
            ? cert?.CertId === remote
            : matches(cert?.Certificate?.Certificate)),
        provider_certificate_id: cert?.CertId ?? "",
      });
    }
  }
  const verified = results.length > 0 && results.every((r) => r.verified);
  if (verified && provider !== "aliyun" && !remote) {
    const id = results[0].provider_certificate_id;
    if (id)
      options.deps.db.run(
        "INSERT OR REPLACE INTO ops_cloud_certificates VALUES(?,?,?,?,?,?)",
        mapID,
        target.spec.credential_id,
        material.fingerprint_sha256,
        id,
        "uploaded",
        options.deps.now().toISOString(),
      );
  }
  return {
    verified,
    state: verified ? "applied" : "unknown",
    certificate_version: material.certificate_version,
    fingerprint_sha256: material.fingerprint_sha256,
    domains: results,
    provider,
    read_only: true,
  };
}
export async function deployCloudCertificate(
  options: PlatformOptions,
  target: PlatformResource,
  material: CloudCertificate,
  actor: string,
): Promise<Record<string, any>> {
  if (!options.store.authorized(actor))
    throw new HTTPError(403, "operations_authorization_revoked");
  const spec = target.spec,
    client = clientFor(options, spec.credential_id),
    provider = client.credential.provider;
  if (provider !== spec.provider || spec.product !== "cdn")
    throw new CloudError("unsupported_certificate_cloud_target");
  initCloudSchema(options);
  const db = options.deps.db,
    at = () => options.deps.now().toISOString(),
    mapID = hash(
      provider +
        "\0" +
        client.credential.access_key_id +
        "\0" +
        spec.credential_id +
        "\0" +
        material.fingerprint_sha256,
    );
  let remote =
    db.get<any>("SELECT * FROM ops_cloud_certificates WHERE id=?", mapID)
      ?.provider_certificate_id ?? "";
  const name =
      "lightmoni_" + material.fingerprint_sha256.replace(/:/g, "").slice(0, 32),
    results: Record<string, any>[] = [];
  const authorized = () => {
    if (!options.store.authorized(actor))
      throw new HTTPError(403, "operations_authorization_revoked");
  };
  if (provider !== "aliyun" && !remote) {
    const existing = db.get<any>(
      "SELECT * FROM ops_cloud_certificates WHERE id=?",
      mapID,
    );
    if (existing?.state === "unknown")
      throw new CloudError("cloud_certificate_upload_unknown", "", true);
    db.run(
      "INSERT OR REPLACE INTO ops_cloud_certificates(id,credential_id,fingerprint,provider_certificate_id,state,updated_at) VALUES(?,?,?,?,?,?)",
      mapID,
      spec.credential_id,
      material.fingerprint_sha256,
      "",
      "uploading",
      at(),
    );
    try {
      authorized();
      if (provider === "tencent") {
        const result = await client.request(
          "tencent",
          "ssl",
          "UploadCertificate",
          "2019-12-05",
          {
            CertificatePublicKey: material.certificate_pem,
            CertificatePrivateKey: material.private_key_pem,
            CertificateType: "SVR",
            Alias: name,
            Repeatable: false,
          },
          true,
        );
        remote = result.CertificateId || result.RepeatCertId;
      } else {
        try {
          const result = await client.request(
            "volcengine",
            "CDN",
            "AddCertificate",
            "2021-03-01",
            {
              Source: "volc_cert_center",
              Certificate: material.certificate_pem.replace(/\r?\n/g, "\r\n"),
              PrivateKey: material.private_key_pem.replace(/\r?\n/g, "\r\n"),
              Repeatable: false,
              Desc: name,
            },
            true,
          );
          remote = result.CertId;
        } catch (e) {
          if (
            (e as any).code === "InvalidParameter.Certificate.Duplicated" &&
            (e as any).certificate_id
          )
            remote = (e as any).certificate_id;
          else throw e;
        }
      }
      if (typeof remote !== "string" || !remote)
        throw new CloudError("cloud_certificate_id_missing", "", true);
      db.run(
        "UPDATE ops_cloud_certificates SET provider_certificate_id=?,state='uploaded',updated_at=? WHERE id=?",
        remote,
        at(),
        mapID,
      );
    } catch (e) {
      db.run(
        "UPDATE ops_cloud_certificates SET state=?,updated_at=? WHERE id=?",
        (e as any).state === "unknown" ? "unknown" : "failed",
        at(),
        mapID,
      );
      throw e;
    }
  }
  for (const domain of spec.domains as string[]) {
    try {
      authorized();
      if (provider === "aliyun") {
        // Read before write also recovers a previous bind whose HTTP reply was lost.
        const read = () =>
          client.request(
            "aliyun",
            "cdn",
            "DescribeDomainCertificateInfo",
            "2018-05-10",
            { DomainName: domain },
          );
        let info = (await read()).CertInfos?.CertInfo?.find(
          (r: any) => r.DomainName === domain,
        );
        const matches = (r: any) => {
          try {
            return (
              r?.ServerCertificateStatus === "on" &&
              (!r.Status || r.Status === "success") &&
              new X509Certificate(r.ServerCertificate).fingerprint256 ===
                material.fingerprint_sha256
            );
          } catch {
            return false;
          }
        };
        let uncertain = false;
        if (!matches(info)) {
          authorized();
          try {
            await client.request(
              "aliyun",
              "cdn",
              "SetCdnDomainSSLCertificate",
              "2018-05-10",
              {
                DomainName: domain,
                CertName: name,
                CertType: "upload",
                SSLProtocol: "on",
                SSLPub: material.certificate_pem,
                SSLPri: material.private_key_pem,
              },
              true,
            );
          } catch (e) {
            if ((e as any).state !== "unknown") throw e;
            uncertain = true;
          }
          try {
            info = (await read()).CertInfos?.CertInfo?.find(
              (r: any) => r.DomainName === domain,
            );
          } catch (e) {
            if (uncertain)
              throw new CloudError("cloud_result_unknown", "", true);
            throw e;
          }
        }
        if (uncertain && !matches(info))
          throw new CloudError("cloud_result_unknown", "", true);
        results.push({
          domain,
          verified: matches(info),
          provider_certificate_id: String(info?.CertId ?? ""),
          state: matches(info) ? "applied" : "verifying",
        });
      } else if (provider === "tencent") {
        const read = async () => {
          const result = await client.request(
            "tencent",
            "cdn",
            "DescribeDomainsConfig",
            "2018-06-06",
            {
              Filters: [{ Name: "domain", Value: [domain], Fuzzy: false }],
              Limit: 100,
            },
          );
          return result.Domains?.find((r: any) => r.Domain === domain);
        };
        let info = await read();
        if (!info) throw new CloudError("cloud_domain_not_found");
        let uncertain = false;
        if (
          info.Https?.CertInfo?.CertId !== remote ||
          info.Https?.Switch !== "on"
        ) {
          const enabled = info.Https?.Switch === "on",
            route = enabled ? "Https.CertInfo.CertId" : "Https";
          const value: any = enabled
            ? { update: remote }
            : {
                update: {
                  ...info.Https,
                  Switch: "on",
                  CertInfo: { CertId: remote },
                },
              };
          if (!enabled) delete value.update.SslStatus;
          authorized();
          try {
            await client.request(
              "tencent",
              "cdn",
              "ModifyDomainConfig",
              "2018-06-06",
              { Domain: domain, Route: route, Value: JSON.stringify(value) },
              true,
            );
          } catch (e) {
            if ((e as any).state !== "unknown") throw e;
            uncertain = true;
          }
          try {
            info = await read();
          } catch (e) {
            if (uncertain)
              throw new CloudError("cloud_result_unknown", "", true);
            throw e;
          }
        }
        if (uncertain && info?.Https?.CertInfo?.CertId !== remote)
          throw new CloudError("cloud_result_unknown", "", true);
        const verified =
          info?.Https?.CertInfo?.CertId === remote &&
          info?.Https?.Switch === "on" &&
          info?.Https?.SslStatus === "deployed";
        results.push({
          domain,
          verified,
          provider_certificate_id: remote,
          state: verified
            ? "applied"
            : info?.Https?.SslStatus === "failed"
              ? "failed"
              : "verifying",
          ...(info?.Https?.SslStatus === "failed"
            ? { code: "cloud_certificate_deploy_failed" }
            : {}),
        });
      } else {
        const read = async () => {
          const r = await client.request(
            "volcengine",
            "CDN",
            "DescribeCdnConfig",
            "2021-03-01",
            { Domain: domain },
          );
          return r.DomainConfig;
        };
        let info = await read();
        let uncertain = false;
        if (info?.HTTPS?.CertInfo?.CertId !== remote) {
          authorized();
          try {
            const result = await client.request(
              "volcengine",
              "CDN",
              "BatchDeployCert",
              "2021-03-01",
              { CertId: remote, Domain: domain },
              true,
            );
            if (
              !result.DeployResult?.some(
                (r: any) => r.Domain === domain && r.Status === "success",
              )
            )
              throw new CloudError("cloud_certificate_bind_failed");
          } catch (e) {
            if ((e as any).state !== "unknown") throw e;
            uncertain = true;
          }
          try {
            info = await read();
          } catch (e) {
            if (uncertain)
              throw new CloudError("cloud_result_unknown", "", true);
            throw e;
          }
        }
        if (uncertain && info?.HTTPS?.CertInfo?.CertId !== remote)
          throw new CloudError("cloud_result_unknown", "", true);
        if (
          info?.HTTPS?.CertInfo?.CertId === remote &&
          info?.HTTPS?.Switch !== true
        ) {
          const https: Record<string, any> = {
            Switch: true,
            CertInfo: { CertId: remote },
          };
          for (const key of [
            "DisableHttp",
            "ForcedRedirect",
            "HTTP2",
            "OCSP",
            "TlsVersion",
            "Hsts",
            "Keyless",
          ])
            if (info.HTTPS?.[key] !== undefined) https[key] = info.HTTPS[key];
          authorized();
          try {
            await client.request(
              "volcengine",
              "CDN",
              "UpdateCdnConfig",
              "2021-03-01",
              { Domain: domain, HTTPS: https },
              true,
            );
          } catch (e) {
            if ((e as any).state !== "unknown") throw e;
            uncertain = true;
          }
          try {
            info = await read();
          } catch (e) {
            if (uncertain)
              throw new CloudError("cloud_result_unknown", "", true);
            throw e;
          }
          if (uncertain && info?.HTTPS?.Switch !== true)
            throw new CloudError("cloud_result_unknown", "", true);
        }
        const verified =
          info?.HTTPS?.CertInfo?.CertId === remote &&
          info?.HTTPS?.Switch === true;
        results.push({
          domain,
          verified,
          provider_certificate_id: remote,
          state: verified ? "applied" : "verifying",
        });
      }
    } catch (error) {
      results.push({
        domain,
        verified: false,
        state: (error as any).state === "unknown" ? "unknown" : "failed",
        code:
          error instanceof CloudError
            ? error.code
            : "cloud_certificate_deployment_failed",
      });
    }
  }
  const verified = results.length > 0 && results.every((r) => r.verified);
  return {
    verified,
    state: verified
      ? "applied"
      : results.some((r) => r.state === "unknown")
        ? "unknown"
        : results.some((r) => r.state === "failed")
          ? "failed"
          : "verifying",
    certificate_version: material.certificate_version,
    fingerprint_sha256: material.fingerprint_sha256,
    domains: results,
    provider,
  };
}
