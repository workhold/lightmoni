export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
  provider_options?: Record<string, Record<string, string>>;
}
export interface Message {
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  provider_state?: { type: "reasoning" | "text"; text?: string; provider_options: Record<string, Record<string, string>> }[];
}
export interface Input {
  system: string;
  // Private worker instruction. It is never part of the saved model config.
  connection_test?: boolean;
  config: {
    base_url: string;
    protocol?: import("./model.js").Protocol;
    model: string;
    api_key?: string;
    max_input_tokens: number;
    max_output_tokens: number;
    max_steps: number;
    reasoning_effort?: 'provider-default'|'none'|'minimal'|'low'|'medium'|'high'|'xhigh';
  };
  messages: Message[];
  summary?: string;
  summary_through?: number;
  context?: unknown;
  tools: {
    name: string;
    description: string;
    schema: Record<string, unknown>;
  }[];
}
export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}
export function reportedUsage(value: unknown): Usage | undefined {
  if (!value || typeof value !== "object") return;
  const v = value as Record<string, unknown>,
    result: Usage = {};
  for (const [source, target] of [
    ["inputTokens", "input_tokens"],
    ["outputTokens", "output_tokens"],
    ["totalTokens", "total_tokens"],
  ] as const) {
    const raw = v[source],
      n =
        typeof raw === "object" && raw !== null
          ? (raw as { total?: unknown }).total
          : raw;
    if (typeof n === "number" && Number.isSafeInteger(n) && n >= 0)
      result[target] = n;
  }
  return Object.keys(result).length ? result : undefined;
}
