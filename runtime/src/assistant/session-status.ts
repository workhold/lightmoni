import type { Event, Session } from "./types.js";

export type SessionStatus = "running" | "needs_action" | "failed" | "idle";

function needsReview(value: unknown, depth = 0): boolean {
  if (!value || typeof value !== "object" || depth > 3) return false;
  if (Array.isArray(value)) return value.some(item => needsReview(item, depth + 1));
  const item = value as Record<string, unknown>;
  if (item.status === "awaiting_approval" || item.state === "awaiting_approval") return true;
  return ["proposal", "plan", "result"].some(key => needsReview(item[key], depth + 1));
}

export function sessionStatus(session: Session, active: boolean, currentReview?: (event: Event) => boolean | undefined): SessionStatus {
  if (active) return "running";
  const events = session.events ?? [];
  const latest = [...events].reverse().find(event => event.type === "user.message") as Event | undefined;
  if (!latest) return "idle";
  const turn = events.filter(event => event.turn_id === latest.turn_id);
  if (turn.some(event => event.type === "turn.failed")) return "failed";
  if (!turn.some(event => ["turn.completed", "turn.cancelled"].includes(event.type))) return "failed";
  if (turn.some(event => event.type === "turn.cancelled")) return "idle";
  return turn.some(event => event.type === "tool.result" && event.data.status === "success" &&
    (currentReview?.(event) ?? (event.data.tool === "draft_dashboard" && !!event.data.value?.draft || needsReview(event.data.value)))) ? "needs_action" : "idle";
}
