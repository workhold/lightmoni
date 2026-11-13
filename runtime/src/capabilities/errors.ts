const CATEGORY: Record<number, string> = {
  400: "invalid_input", 401: "unauthenticated", 403: "permission_denied", 404: "not_found",
  409: "conflict", 413: "input_limit", 429: "rate_limited", 504: "timeout",
};
const DETAILS = new Set([
  "invalid_input", "invalid_cursor", "capability_not_found", "capability_forbidden", "resource_not_found",
  "scope_required", "host_id_required", "explicit_hosts_required", "assistant_session_required",
  "idempotency_conflict", "authorization_unavailable", "unsupported_external_proposal", "input_too_large",
  "result_too_large", "output_invalid", "rate_limited", "concurrency_limit", "timeout", "cancelled",
  "capability_unavailable",
]);
export function capabilityErrorStatus(error: unknown): number {
  const value = (error as {status?: unknown})?.status;
  return typeof value === "number" && value >= 400 && value < 600 ? value : 500;
}
export function capabilityErrorCategory(status: number): string {
  return CATEGORY[status] ?? "unavailable";
}
export function capabilityErrorDetail(error: unknown, status = capabilityErrorStatus(error)): string {
  const code = (error as {code?: unknown})?.code;
  if (typeof code === "string" && DETAILS.has(code)) return code;
  const message = (error as {message?: unknown})?.message;
  if (typeof message === "string" && DETAILS.has(message)) return message;
  if (status === 413 && message === "result_too_large") return message;
  return capabilityErrorCategory(status);
}
