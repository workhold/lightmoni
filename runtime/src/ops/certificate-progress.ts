import {CloudError} from "./cloud.js";
import {HTTPError} from "../shared/http.js";
import type {PlatformStore} from "./types.js";

export type CertificateDiagnostic = {
  code: string; message: string; phase: string; state: "failed" | "unknown";
  error_type?: string; http_status?: number; request_id?: string; domain?: string;
};
export class CertificateIssueError extends Error {
  constructor(readonly diagnostic: CertificateDiagnostic) {super(diagnostic.code);}
}

/** Only selected, bounded explanations are public. Never serialize an upstream error. */
export class CertificateProgress {
  private secrets = new Set<string>();
  constructor(private store: PlatformStore, readonly runID: string) {
    for (const kind of ["credential", "acme_account"] as const)
      for (const resource of store.list(kind))
        for (const [key, value] of Object.entries(resource.spec))
          if (/secret|password|token|hmac|eab_kid|access_key_id/i.test(key)) this.remember(value);
  }
  remember(value: unknown) {
    if (typeof value === "string" && value.length >= 4) this.secrets.add(value);
  }
  redact(value: string): string {
    let result = value.replace(/-----BEGIN[\s\S]*?-----END[^-]+-----/g, "[redacted]");
    for (const secret of [...this.secrets].sort((a, b) => b.length - a.length))
      result = result.split(secret).join("[redacted]");
    return result
      .replace(/(\bTXT(?:\s+record)?\s*(?:[:=]\s*)?)(?:"[^"]*"|'[^']*')/gi, "$1[redacted]")
      .replace(/\b(Bearer|Basic)\s+[^\s,;'"]+/gi, "$1 [redacted]")
      .replace(/((?:access[_-]?key(?:[_-]?(?:id|secret))?|secret|password|token|nonce|signature|authorization|keyAuthorization|eab_hmac_key)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, "$1[redacted]")
      .replace(/https?:\/\/[^\s"'<>]+/gi, raw => {
        try {const url = new URL(raw); return url.origin + url.pathname;}
        catch {return "[redacted URL]";}
      }).replace(/[\u0000-\u0008\u000b-\u001f]/g, " ").slice(0, 1200);
  }
  diagnostic(error: unknown, phase: string, fallback = "acme_issuance_failed"): CertificateDiagnostic {
    if (error instanceof CertificateIssueError) return error.diagnostic;
    const e = error as any, data = e?.response?.data;
    const candidate = error instanceof CloudError ? error.code : error instanceof HTTPError ? error.message : e?.code;
    const code = typeof candidate === "string" && /^[a-zA-Z][a-zA-Z0-9_.-]{0,179}$/.test(candidate) && this.redact(candidate) === candidate ? candidate : fallback;
    let rawMessage = data?.error?.detail ?? data?.detail ?? e?.message;
    // acme-client can stringify an entire response when no problem detail exists.
    // Keep the selected explanation only, never that serialized response.
    if (typeof rawMessage === "string" && /^[\s]*[\[{]/.test(rawMessage)) {
      try {const body = JSON.parse(rawMessage); rawMessage = body?.error?.detail ?? body?.detail ?? code;}
      catch {rawMessage = code;}
    }
    const message = this.redact(typeof rawMessage === "string" ? rawMessage : code);
    const errorType = data?.error?.type ?? data?.type ?? e?.type;
    const status = e?.response?.status ?? e?.statusCode;
    const requestID = e?.request_id;
    return {code, message, phase, state: e?.state === "unknown" || e?.unknown === true ? "unknown" : "failed",
      ...(typeof errorType === "string" && /^(urn:ietf:params:acme:error:)?[a-zA-Z][\w.-]{0,100}$/.test(errorType) && this.redact(errorType) === errorType ? {error_type: errorType} : {}),
      ...(Number.isInteger(status) && status >= 100 && status <= 599 ? {http_status: status} : {}),
      ...(typeof requestID === "string" && /^[\w.-]{1,128}$/.test(requestID) && this.redact(requestID) === requestID ? {request_id: requestID} : {})};
  }
  problemDiagnostic(problem: unknown, phase: string, code: string, domains: string[], domain?: string): CertificateDiagnostic | undefined {
    const entries: {message: string; type?: unknown; status?: unknown; domain?: string; depth: number}[] = [];
    const knownDomain = (value: unknown) => typeof value === "string" && domains.includes(value) ? value : undefined;
    const visit = (value: any, inherited: string | undefined, depth: number) => {
      if (!value || typeof value !== "object" || depth > 2 || entries.length >= 5) return;
      const target = knownDomain(value.identifier?.value) ?? inherited;
      if (typeof value.detail === "string" && value.detail.trim())
        entries.push({message: this.redact(value.detail), type: value.type, status: value.status, domain: target, depth});
      if (Array.isArray(value.subproblems))
        for (const child of value.subproblems.slice(0, 5)) visit(child, target, depth + 1);
    };
    visit(problem, knownDomain(domain), 0);
    if (!entries.length) return;
    const specific = entries.find(entry => entry.depth > 0) ?? entries[0];
    const diagnostic = this.diagnostic(Object.assign(new Error(entries.map(entry => (entry.domain ? entry.domain + ": " : "") + entry.message).join("\n")),
      {code, type: specific.type ?? (problem as any)?.type, statusCode: specific.status ?? (problem as any)?.status}), phase);
    return {...diagnostic, ...(specific.domain ? {domain: specific.domain} : {})};
  }
  wrap(error: unknown, phase: string, fallback?: string) {
    return new CertificateIssueError(this.diagnostic(error, phase, fallback));
  }
  event(phase: string, state: string, detail: Record<string, any> = {}) {
    const safe = {...detail};
    if (typeof safe.message === "string") safe.message = this.redact(safe.message);
    this.store.addRunEvent(this.runID, phase, state, safe);
  }
  async step<T>(phase: string, work: () => Promise<T>, detail: Record<string, any> = {}, fallback?: string): Promise<T> {
    this.event(phase, "running", detail);
    try {const result = await work(); this.event(phase, (result as any)?.verified === false ? "warning" : "succeeded", detail); return result;}
    catch (error) {
      const failure = this.diagnostic(error, phase, fallback);
      this.event(phase, failure.state, {...detail, ...failure});
      throw new CertificateIssueError(failure);
    }
  }
}
