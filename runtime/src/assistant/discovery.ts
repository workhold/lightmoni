import { AssistantError, bytes, control, object, text } from "./types.js";
import {
  ANTHROPIC,
  CHAT,
  GOOGLE,
  RESPONSES,
  canonicalBase,
  candidates,
  directoryRequest,
  protocolBase,
  protocolHint,
  protocols,
} from "./provider.js";
interface Outcome {
  ok?: boolean;
  status: number;
  code?: string;
  message?: string;
  fallback?: boolean;
  retry?: boolean;
  truncated?: boolean;
  protocol?: string;
  models?: { id: string }[];
}
const failure = (
  code: string,
  message: string,
  fallback = false,
  retry = false,
): Outcome => ({ status: 502, code, message, fallback, retry });
export function parseDirectory(
  body: string,
  key: string,
  profile: string,
): Outcome {
  const unsupported = () =>
    failure(
      "directory_unsupported",
      "model directory format is unsupported; choose a protocol and enter the model name manually",
      true,
      true,
    );
  let d: any;
  try {
    d = JSON.parse(body);
  } catch {
    return unsupported();
  }
  if (!d || typeof d !== "object" || Array.isArray(d)) return unsupported();
  let protocol = profile;
  if (!protocol || protocol === "auto")
    protocol =
      typeof d.has_more === "boolean"
        ? ANTHROPIC
        : d.models != null
          ? GOOGLE
          : CHAT;
  const items =
    profile === GOOGLE || d.data == null ? (d.models ?? d.data) : d.data;
  if (!Array.isArray(items)) return unsupported();
  const names = new Set<string>();
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    let id = item.id;
    if (d.models != null && (profile === GOOGLE || d.data == null)) {
      id =
        typeof item.name === "string" ? item.name.replace(/^models\//, "") : "";
      if (
        profile === GOOGLE &&
        Array.isArray(item.supportedGenerationMethods) &&
        item.supportedGenerationMethods.length &&
        !item.supportedGenerationMethods.some((m: string) =>
          ["generateContent", "streamGenerateContent"].includes(m),
        )
      )
        continue;
    } else if (!id && typeof item.name === "string")
      id = item.name.replace(/^models\//, "");
    if (
      typeof id === "string" &&
      id.trim() &&
      bytes(id) <= 200 &&
      !control(id) &&
      (!key || !id.includes(key))
    )
      names.add(id);
  }
  const ids = [...names].sort();
  return {
    ok: true,
    status: 200,
    protocol,
    truncated: !!d.has_more || !!d.nextPageToken || ids.length > 500,
    models: ids.slice(0, 500).map((id) => ({ id })),
  };
}
async function directory(
  base: string,
  key: string,
  profile: string,
  signal: AbortSignal,
): Promise<Outcome> {
  const request = directoryRequest(base, key, profile);
  let response: Response;
  try {
    response = await fetch(request.url, {
      headers: request.headers,
      signal,
      redirect: "error",
    });
  } catch {
    return signal.aborted
      ? {
          status: 504,
          code: "timeout",
          message: "model directory request timed out",
        }
      : failure(
          "provider_unavailable",
          "model directory connection failed or redirected",
        );
  }
  try {
    if ([401, 403].includes(response.status))
      return failure(
        "credentials_rejected",
        "model directory rejected credentials; enter a valid API key and check permissions",
        true,
        true,
      );
    if ([404, 405].includes(response.status))
      return failure(
        "directory_unsupported",
        "model directory is unavailable; choose a protocol and enter the model name manually",
        true,
        true,
      );
    if (response.status !== 200)
      return failure(
        "provider_unavailable",
        response.status === 429
          ? "model directory request was rate limited; retry later"
          : "model directory provider returned an error",
      );
    const reader = response.body?.getReader();
    if (!reader)
      return failure(
        "provider_unavailable",
        "model directory response was interrupted",
      );
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.length;
        if (length > 1 << 20) {
          await reader.cancel();
          return failure(
            "provider_unavailable",
            "model directory response exceeds its size limit",
          );
        }
        chunks.push(chunk.value);
      }
      return parseDirectory(Buffer.concat(chunks).toString(), key, profile);
    } catch {
      return signal.aborted
        ? {
            status: 504,
            code: "timeout",
            message: "model directory request timed out",
          }
        : failure(
            "provider_unavailable",
            "model directory response was interrupted",
          );
    }
  } finally {
    await response.body?.cancel().catch(() => {});
  }
}
export async function discover(
  raw: any,
  signal: AbortSignal,
  keyFor: (base: string, key: string, saved: boolean) => string,
): Promise<any> {
  let input: any;
  try {
    input = object(raw, ["base_url", "api_key", "use_saved_key", "protocol"]);
    if (input.use_saved_key != null && typeof input.use_saved_key !== "boolean")
      throw Error();
    input = {
      base_url: text(input.base_url),
      api_key: text(input.api_key),
      use_saved_key: input.use_saved_key === true,
      protocol: text(input.protocol) || "auto",
    };
    canonicalBase(input.base_url);
    if (bytes(input.api_key) > 4096 || control(input.api_key)) throw Error();
  } catch {
    throw new AssistantError(
      400,
      "invalid model discovery input",
      "invalid_input",
    );
  }
  if (input.protocol !== "auto" && !protocols.includes(input.protocol))
    throw new AssistantError(
      400,
      "select a supported model protocol",
      "invalid_protocol",
    );
  let protocol = input.protocol,
    source = "manual",
    profiles = [protocol];
  if (protocol === "auto") {
    [protocol, source] = protocolHint(input.base_url);
    profiles = protocol ? [protocol] : [CHAT, ANTHROPIC, GOOGLE];
  }
  let outcome: Outcome | undefined,
    authFailure: Outcome | undefined,
    keyFailure: AssistantError | undefined,
    requests = 0,
    stop = false;
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(8000)]);
  for (const profile of profiles) {
    if (stop || requests >= 7) break;
    const base = protocolBase(input.base_url, profile);
    let key: string;
    try {
      key = keyFor(base, input.api_key, input.use_saved_key);
    } catch (error) {
      if (
        error instanceof AssistantError &&
        error.code === "saved_key_mismatch"
      ) {
        keyFailure = error;
        continue;
      }
      throw error;
    }
    const destinations = candidates(
      base,
      profile,
      !input.api_key && input.use_saved_key,
    );
    for (let i = 0; i < destinations.length && requests < 7; i++) {
      outcome = await directory(destinations[i], key, profile, deadline);
      requests++;
      if (outcome.ok) {
        let confirmation = false,
          options = [protocol];
        if (!protocol) {
          protocol = outcome.protocol || CHAT;
          source = "catalog";
          options = protocol === CHAT ? [CHAT, RESPONSES] : [protocol];
          confirmation = protocol === CHAT;
        }
        return {
          base_url: destinations[i],
          protocol,
          protocol_options: options,
          protocol_source: source,
          requires_confirmation: confirmation,
          capabilities_verified: false,
          models: outcome.models,
          truncated: outcome.truncated,
        };
      }
      if (outcome.code === "credentials_rejected") authFailure = outcome;
      if (i + 1 < destinations.length && outcome.fallback) continue;
      if (!outcome.retry) stop = true;
      break;
    }
  }
  if (!outcome && keyFailure) throw keyFailure;
  if (
    authFailure &&
    ["directory_unsupported", "provider_unavailable"].includes(
      outcome?.code || "",
    )
  )
    outcome = authFailure;
  throw new AssistantError(
    outcome?.status || 502,
    outcome?.message || "cannot request model directory",
    outcome?.code || "provider_unavailable",
  );
}
