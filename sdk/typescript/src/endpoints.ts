export interface CenterEndpoint { url: string; scope: "internal" | "public" }
export interface EndpointSnapshot {
  version: number; center_id: string; revision: string;
  endpoints: CenterEndpoint[]; refresh_after_seconds: number;
}
export function centerURL(value: string): string {
  const u = new URL(value);
  if (!/^https?:$/.test(u.protocol) || !u.hostname || u.username || u.password || u.search || u.hash || u.port === "0" || /[?#\\\s]/.test(value))
    throw new Error("a center HTTP(S) endpoint without credentials or query is required");
  return value.replace(/\/+$/, "");
}
async function boundedJSON(response: Response): Promise<any> {
  if (!response.body) throw new Error("empty center discovery response");
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) { const p = await reader.read(); if (p.done) break; size += p.value.length;
      if (size > 65536) { await reader.cancel(); throw new Error("center discovery response too large"); } chunks.push(p.value); }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const c of chunks) { bytes.set(c, offset); offset += c.length; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

/** Select before sending; never replay a request body across entrances. */
export class CenterEndpoints {
  readonly bootstrap: string;
  private snapshot?: EndpointSnapshot;
  private expires = 0;
  private selected = "";
  private selectedUntil = 0;
  private failed = new Map<string, number>();
  private loading?: Promise<string>;
  private controller = new AbortController();
  lastError = "";
  constructor(bootstrap: string, private headers: () => HeadersInit = () => ({}), private fetcher: typeof fetch = fetch) {
    this.bootstrap = centerURL(bootstrap);
  }
  status() { return { endpoint: this.selected || this.bootstrap, scope: this.snapshot?.endpoints.find(e => e.url === this.selected)?.scope ?? "public", revision: this.snapshot?.revision ?? "", error: this.lastError }; }
  close() { this.controller.abort(); }
  private async json(url: string, headers: HeadersInit, parent?: AbortSignal) {
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(1000), ...(parent ? [parent] : [])]);
    const response = await this.fetcher(url, { headers, signal, redirect: "error", cache: "no-store" });
    if (response.status !== 200) { await response.body?.cancel(); throw new Error("center discovery HTTP " + response.status); }
    return boundedJSON(response);
  }
  async refresh(parent?: AbortSignal): Promise<string> {
    this.expires = 0; this.selectedUntil = 0;
    return this.resolve(parent);
  }
  async resolve(parent?: AbortSignal): Promise<string> {
    if (parent?.aborted) throw parent.reason;
    if (Date.now() < this.selectedUntil && this.selected) return this.selected;
    this.loading ??= this.select(AbortSignal.timeout(5000)).finally(() => { this.loading = undefined; });
    const shared=this.loading;
    if(!parent)return shared;
    return new Promise<string>((resolve,reject)=>{
      const abort=()=>reject(parent.reason);parent.addEventListener("abort",abort,{once:true});
      shared.then(resolve,reject).finally(()=>parent.removeEventListener("abort",abort));
      if(parent.aborted)abort();
    });
  }
  private async select(parent?: AbortSignal): Promise<string> {
    const now = Date.now();
    const verified = new Set<string>();
    if (now >= this.expires) {
      this.expires = now + 30000;
      const sources = [...new Set([this.selected, this.bootstrap, ...(this.snapshot?.endpoints.filter(e=>e.scope==="public").map(e=>e.url)??[])].filter(Boolean))];
      for (const source of sources) {
        try {
          if(this.snapshot){const identity=await this.json(source+"/v1/center-identity",{},parent);if(identity.center_id!==this.snapshot.center_id)throw new Error("center identity mismatch");}
          const raw = await this.json(source + "/v1/center-endpoints", this.headers(), parent);
          if (raw.version !== 1 || typeof raw.center_id !== "string" || !raw.center_id || raw.center_id.length > 128 || typeof raw.revision !== "string" || !raw.revision || raw.revision.length>128 || !Array.isArray(raw.endpoints) || !raw.endpoints.length || raw.endpoints.length > 20)
            throw new Error("invalid center endpoint manifest");
          if (this.snapshot && raw.center_id !== this.snapshot.center_id) throw new Error("center identity mismatch");
          const endpoints = raw.endpoints.map((e: any) => {
            if (!e || !["internal", "public"].includes(e.scope)) throw new Error("invalid center endpoint scope");
            return { url: centerURL(e.url), scope: e.scope };
          });
          if (!endpoints.some((e: CenterEndpoint) => e.scope === "public")) throw new Error("public center endpoint required");
          const changed = this.snapshot?.revision !== raw.revision;
          this.snapshot = { ...raw, endpoints };
          if (changed) this.failed.clear();
          this.lastError = "";
          verified.add(source);
          break;
        } catch (e) {
          this.lastError = e instanceof Error ? e.message : "center discovery failed";
          if (/HTTP (401|403)/.test(this.lastError)) throw new Error(this.lastError);
        }
      }
    }
    if (!this.snapshot) { this.selected = this.bootstrap; this.selectedUntil = this.expires; return this.selected; }
    const candidates = [...this.snapshot.endpoints].sort((a, b) => Number(a.scope === "public") - Number(b.scope === "public"));
    // Retain the explicitly trusted bootstrap for recovery even when removed from the address book.
    if (!candidates.some(e => e.url === this.bootstrap)) candidates.push({ url: this.bootstrap, scope: "public" });
    candidates.sort((a,b)=>Number(a.scope==='public')-Number(b.scope==='public') || Number(!(verified.has(a.url)||a.url===this.bootstrap))-Number(!(verified.has(b.url)||b.url===this.bootstrap)));
    const deadline = Date.now() + 3000;
    for (const e of candidates) {
      if ((this.failed.get(e.url) ?? 0) > now || (e.scope === "internal" && Date.now() >= deadline)) continue;
      if(verified.has(e.url)){this.selected=e.url;this.selectedUntil=this.expires;return e.url;}
      if(parent?.aborted)break;
      try {
        const identity = await this.json(e.url + "/v1/center-identity", {}, parent);
        if (identity.center_id !== this.snapshot.center_id) throw new Error("center identity mismatch");
        this.selected = e.url; this.selectedUntil = this.expires; return e.url;
      } catch (error) {
        if(!parent?.aborted)this.failed.set(e.url, now + 30000);
        this.lastError = error instanceof Error ? error.message : "center probe failed";
      }
    }
    throw new Error("no verified center endpoint is reachable");
  }
  failedRequest(endpoint: string) { this.failed.set(endpoint, Date.now() + 30000); this.selectedUntil = 0; }
  async request(path: string, init: RequestInit = {}): Promise<Response> {
    const endpoint = await this.resolve(init.signal ?? undefined);
    const failed=(error:unknown)=>{
      const cause=(error as any)?.cause?.code??"";
      if(/CERT|TLS|SSL/.test(cause))return;
      if(!init.signal?.aborted || init.signal.reason?.name==="TimeoutError")this.failedRequest(endpoint);
    };
    try {
      const response=await this.fetcher(endpoint + path, { ...init, redirect: "error" });
      if(!response.body)return response;
      const reader=response.body.getReader();
      const body=new ReadableStream<Uint8Array>({async pull(controller){try{const p=await reader.read();if(p.done)controller.close();else controller.enqueue(p.value);}catch(error){failed(error);controller.error(error);}},cancel(reason){return reader.cancel(reason);}});
      return new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
    } catch (error) { failed(error); throw error; }
  }
  /** Use for existing Agent clients that construct URLs from their bootstrap. */
  fetch: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(this.bootstrap + "/")) throw new Error("request outside configured center");
    return this.request(url.slice(this.bootstrap.length), init);
  };
}
