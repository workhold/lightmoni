import { continuationOptions } from "./model.js";
import type { Message } from "./protocol.js";

// UTF-8 bytes upper-bound common tokenizers with additional protocol slack.
// This is a conservative budget estimate, not provider-reported token usage.
export function estimate(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8") + 256;
}
export function roundStarts(messages: Message[]): number[] {
  return messages.flatMap((m, i) => (m.role === "user" ? [i] : []));
}
export function compactionPlan(
  messages: Message[],
  through: number,
  summary: string,
  system: string,
  tools: unknown[],
  budget: number,
) {
  if (
    !Number.isInteger(through) ||
    through < 0 ||
    through > messages.length ||
    (through > 0 && messages[through]?.role !== "user")
  )
    throw Error("invalid_history");
  const overhead = estimate(system) + estimate(tools) + estimate(summary) + 512;
  const available = Math.floor(budget * 0.85) - overhead;
  const starts = roundStarts(messages).filter((i) => i >= through);
  const latest = starts.at(-1) ?? through;
  if (estimate(messages.slice(latest)) > available)
    throw Error("context_limit");
  if (estimate(messages.slice(through)) <= available)
    return { through, keep: messages.slice(through) };
  // Reserve space for a replacement summary; choose only complete round boundaries.
  const reserve = 1024;
  let cut = latest;
  for (const start of starts.slice(0, -1).reverse()) {
    if (estimate(messages.slice(start)) + reserve > available) break;
    cut = start;
  }
  if (cut === through) cut = starts.find((i) => i > through) ?? latest;
  return { through: cut, keep: messages.slice(cut) };
}
export function toModelMessages(messages: Message[]): any[] {
  const converted: any[] = messages.map((m) => {
    if (m.role === "assistant")
      return {
        role: "assistant",
        content: [
          ...(m.provider_state ?? []).map((p) => ({ type: p.type, text: p.type === "text" ? (p.text ?? "") : "", providerOptions: continuationOptions({providerOptions:p.provider_options}) })),
          ...((m.provider_state ?? []).some(p => p.type === "text") ? [] : (m.content ? [{ type: "text", text: m.content }] : [])),
          ...(m.tool_calls ?? []).map((c) => ({
            type: "tool-call",
            toolCallId: c.id,
            toolName: c.function.name,
            input: JSON.parse(c.function.arguments),
            providerOptions: continuationOptions({providerOptions:c.provider_options}),
          })),
        ],
      };
    if (m.role === "tool")
      return {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: m.tool_call_id,
            toolName: "",
            output: { type: "json", value: JSON.parse(m.content) },
          },
        ],
      };
    return { role: m.role, content: m.content };
  });
  return converted.map((m, _, all) => {
    if (m.role === "tool")
      for (const part of m.content) {
        for (const previous of all)
          if (
            previous.role === "assistant" &&
            Array.isArray(previous.content)
          ) {
            const c = previous.content.find(
              (c: any) =>
                c.type === "tool-call" && c.toolCallId === part.toolCallId,
            );
            if (c) {
              part.toolName = c.toolName;
              break;
            }
          }
      }
    return m;
  });
}
export function fromModelMessages(messages: any[]): Message[] {
  const result: Message[] = [];
  for (const m of messages) {
    if (m.role === "assistant") {
      const parts =
        typeof m.content === "string"
          ? [{ type: "text", text: m.content }]
          : (m.content ?? []);
      const calls = parts
        .filter((p: any) => p.type === "tool-call")
        .map((p: any) => ({
          id: p.toolCallId,
          type: "function" as const,
          ...(continuationOptions(p) ? {provider_options: continuationOptions(p)} : {}),
          function: {
            name: p.toolName,
            arguments: JSON.stringify(p.input ?? p.args ?? {}),
          },
        }));
      result.push({
        role: "assistant",
        content: parts
          .filter((p: any) => p.type === "text")
          .map((p: any) => p.text)
          .join(""),
        ...(parts.some((p:any) => ["reasoning", "text"].includes(p.type) && continuationOptions(p)) ? {provider_state: parts.filter((p:any) => p.type === "text" || (p.type === "reasoning" && continuationOptions(p))).map((p:any) => ({type:p.type, ...(p.type === "text" ? {text:p.text} : {}), provider_options:continuationOptions(p) ?? {}}))} : {}),
        ...(calls.length ? { tool_calls: calls } : {}),
      });
    } else if (m.role === "tool")
      for (const p of m.content ?? []) {
        if (p.type !== "tool-result") continue;
        const output = p.output ?? p.result;
        const value =
          output?.type === "json"
            ? output.value
            : output?.type === "text"
              ? { text: output.value }
              : output;
        result.push({
          role: "tool",
          content: JSON.stringify(value ?? {}),
          tool_call_id: p.toolCallId,
        });
      }
  }
  const calls = result.flatMap((m) => m.tool_calls ?? []);
  const ids = new Set(
    result.filter((m) => m.role === "tool").map((m) => m.tool_call_id),
  );
  if (calls.some((c) => !ids.has(c.id))) throw Error("invalid_checkpoint");
  return result;
}
