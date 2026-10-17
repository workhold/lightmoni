import { AssistantError, bytes, control, type Config } from "./types.js";
export const CHAT = "openai-chat-completions",
  RESPONSES = "openai-responses",
  ANTHROPIC = "anthropic-messages",
  GOOGLE = "google-generative-ai";
export const protocols = [CHAT, RESPONSES, ANTHROPIC, GOOGLE];
export const reasoning = [
  "provider-default",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];
export function normalize(c: Partial<Config>): Config {
  return {
    base_url: "",
    enabled: false,
    ...c,
    protocol: c.protocol || CHAT,
    model: (c.model || "").trim(),
    max_input_tokens: c.max_input_tokens || 32000,
    max_output_tokens: c.max_output_tokens || 4096,
    max_steps: c.max_steps || 8,
    reasoning_effort: c.reasoning_effort || "provider-default",
  };
}
// Preserve escaped tenant-path bytes. Endpoint extraction occurs once, at an input boundary.
export function canonicalBase(raw: string, extract = true): string {
  if (
    typeof raw !== "string" ||
    bytes(raw) > 2048 ||
    control(raw) ||
    raw.includes("#")
  )
    throw new AssistantError(400, "invalid API base URL");
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new AssistantError(400, "invalid API base URL");
  }
  if (
    !["http:", "https:"].includes(u.protocol) ||
    !u.hostname ||
    u.username ||
    u.password ||
    u.search ||
    raw.trim().includes("?")
  )
    throw new AssistantError(400, "invalid API base URL");
  let path = u.pathname.replace(/\/+$/, "");
  if (extract)
    path = path.replace(
      /\/models\/[^/]+:(?:generateContent|streamGenerateContent)$|\/(?:chat\/completions|responses|messages|models)$/,
      "",
    );
  path = path.replace(/\/+$/, "");
  try {
    decodeURIComponent(path);
  } catch {
    throw new AssistantError(400, "invalid API base URL");
  }
  return u.origin + path;
}
export function protocolBase(raw: string, protocol: string): string {
  if (!protocols.includes(protocol))
    throw new AssistantError(400, "select a supported model protocol");
  const base = canonicalBase(raw);
  return protocol !== GOOGLE ? base.replace(/\/v1beta$/, "/v1") : base;
}
export function validate(c: Config): void {
  if (!protocols.includes(c.protocol))
    throw new AssistantError(
      400,
      "select a concrete supported model protocol before saving",
    );
  if (!reasoning.includes(c.reasoning_effort))
    throw new AssistantError(400, "select a supported reasoning effort");
  if (
    !Number.isInteger(c.max_input_tokens) ||
    c.max_input_tokens < 4096 ||
    c.max_input_tokens > 128000 ||
    !Number.isInteger(c.max_output_tokens) ||
    c.max_output_tokens < 256 ||
    c.max_output_tokens > 16384 ||
    !Number.isInteger(c.max_steps) ||
    c.max_steps < 1 ||
    c.max_steps > 12
  )
    throw new AssistantError(
      400,
      "input limit must be 4096–128000, output limit 256–16384 and steps 1–12",
    );
  canonicalBase(c.base_url);
  if (
    !c.model.trim() ||
    bytes(c.model) > 200 ||
    control(c.model) ||
    bytes(c.api_key || "") > 4096 ||
    control(c.api_key || "")
  )
    throw new AssistantError(
      400,
      "model is required and configuration exceeds its allowed size",
    );
}
export function protocolHint(raw: string): [string, string] {
  const u = new URL(raw.trim()),
    p = u.pathname.replace(/\/+$/, "");
  for (const [suffix, protocol] of [
    ["/chat/completions", CHAT],
    ["/responses", RESPONSES],
    ["/messages", ANTHROPIC],
  ])
    if (p.endsWith(suffix)) return [protocol, "endpoint-path"];
  if (/\/models\/[^/]+:(generateContent|streamGenerateContent)$/.test(p))
    return [GOOGLE, "endpoint-path"];
  const known: Record<string, string> = {
    "api.openai.com": RESPONSES,
    "api.anthropic.com": ANTHROPIC,
    "generativelanguage.googleapis.com": GOOGLE,
  };
  return known[u.hostname] ? [known[u.hostname], "official-host"] : ["", ""];
}
export function candidates(
  base: string,
  profile: string,
  saved: boolean,
): string[] {
  if (saved || new URL(base).pathname !== "/") return [base];
  return [
    ...(profile === GOOGLE ? ["v1", "v1beta"] : ["v1"]).map(
      (version) => base + "/" + version,
    ),
    base,
  ];
}
export function directoryRequest(
  base: string,
  key: string,
  profile: string,
): { url: string; headers: Record<string, string> } {
  const url = new URL(base + "/models"),
    headers: Record<string, string> = { Accept: "application/json" };
  if (profile === ANTHROPIC) {
    headers["Anthropic-Version"] = "2023-06-01";
    url.searchParams.set("limit", "500");
    if (key) headers["X-Api-Key"] = key;
  } else if (profile === GOOGLE) {
    url.searchParams.set("pageSize", "500");
    if (key) headers["X-Goog-Api-Key"] = key;
  } else if (key) headers.Authorization = "Bearer " + key;
  return { url: url.toString(), headers };
}
