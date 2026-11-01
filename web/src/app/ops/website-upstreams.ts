// Keep this browser check aligned with normalizeLocations in operations/nginx.ts.
// The server remains authoritative and normalizes accepted URLs to their origin.
type UpstreamIssue = 'scheme' | 'credentials' | 'path' | 'query' | 'invalid';
export function websiteUpstreamIssue(value: unknown): UpstreamIssue | undefined {
  if (typeof value !== "string") return 'invalid';
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return 'scheme';
    if (url.username || url.password) return 'credentials';
    if (url.pathname !== "/") return 'path';
    if (url.search || url.hash) return 'query';
    if (!url.hostname || /[\s{};$]/.test(url.host)) return 'invalid';
  } catch {
    return /^https?:/i.test(value.trim()) ? 'invalid' : 'scheme';
  }
}

export const WEBSITE_UPSTREAM_FIELD_MESSAGES: Record<UpstreamIssue, [string, string]> = {
  scheme: ['请以 http:// 或 https:// 开头，例如 http://127.0.0.1:5000。', 'Start with http:// or https://, for example http://127.0.0.1:5000.'],
  credentials: ['后端 URL 不能包含账号或密码。', 'The upstream URL cannot contain a username or password.'],
  path: ['后端 URL 不能包含路径，请在“转发与负载均衡”中设置 URI。', 'The upstream URL cannot contain a path. Set the URI under Forwarding and load balancing.'],
  query: ['后端 URL 不能包含查询参数或片段。', 'The upstream URL cannot contain a query or fragment.'],
  invalid: ['后端 URL 格式不正确，请检查主机和端口。', 'Invalid upstream URL. Check the host and port.'],
};

export const WEBSITE_UPSTREAM_MESSAGES: Record<string, [string, string]> = {
  INVALID_WEBSITE_UPSTREAM: [
    "后端 URL 格式不正确。请填写 http://主机:端口 或 https://主机:端口，不含账号密码、路径、查询参数或片段。路径转发请在“转发与负载均衡”中设置 URI。",
    "Invalid upstream URL. Use http://host:port or https://host:port without credentials, a path, query or fragment. Configure URI forwarding under Forwarding and load balancing.",
  ],
  WEBSITE_UPSTREAM_REQUIRED: [
    "每个集群的手动后端至少需要一个地址，请添加并填写后端 URL。",
    "Each cluster using manual upstreams needs at least one URL. Add an upstream and enter its URL.",
  ],
  MIXED_UPSTREAM_PROTOCOLS: [
    "同一集群同一路径的后端须统一使用 HTTP 或 HTTPS，请检查后端 URL 的协议。",
    "Upstreams for the same route in a cluster must all use HTTP or all use HTTPS. Check their URL schemes.",
  ],
};
