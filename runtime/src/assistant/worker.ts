import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import {
  bytes,
  publicSession,
  type Message,
  type Runtime,
  type RuntimeFrame,
  type ToolCall,
} from "./types.js";
const names = /^[a-zA-Z0-9_-]{1,64}$/;
const allowedEvents = new Set([
  "assistant.delta",
  "assistant.message",
  "step.started",
  "step.completed",
  "tool.call",
  "tool.result",
  "model.request.started",
  "turn.usage",
  "context.compacting",
  "context.compacted",
]);
const errors: Record<string, string> = {
  context_limit:
    "conversation input exceeds its budget; reduce selected context or increase the input limit",
  summary_failed:
    "history summarization failed; source history is preserved, retry or start a new session",
  step_limit:
    "assistant reached its tool step limit; narrow the request or increase the step limit",
  output_limit:
    "model reached its output limit; narrow the request or increase the output limit",
  test_budget_exceeded:
    "model reasoning exceeds the connection test output budget",
  invalid_history: "assistant history is inconsistent; start a new session",
  invalid_checkpoint: "assistant history is inconsistent; start a new session",
  invalid_provider_state:
    "model continuation state is invalid or exceeds its size limit; start a new session or use another model",
};
export class RuntimeError extends Error {
  constructor(readonly code: string) {
    super(
      errors[code] ||
        "model provider request failed; check endpoint, model and credentials or retry",
    );
  }
}
export function worker(
  node = process.env.LIGHTMONI_AI_NODE || process.execPath,
  entry = process.env.LIGHTMONI_AI_RUNNER ||
    resolve(
      process.cwd().endsWith("/runtime")
        ? "../ai-runtime/dist/runner.js"
        : "ai-runtime/dist/runner.js",
    ),
): Runtime {
  return async (input, signal, tool, event) => {
    try {
      await access(entry);
    } catch {
      throw Error(
        "Mastra runtime is not built; run npm --prefix ai-runtime ci and npm --prefix ai-runtime run build",
      );
    }
    signal.throwIfAborted();
    const child = spawn(node, [entry], { stdio: ["pipe", "pipe", "ignore"] });
    let spawnError = false;
    child.on("error", () => {
      spawnError = true;
    });
    child.stdin.on("error", () => {});
    const exited = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.once("error", () => resolve());
    });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    let force: NodeJS.Timeout | undefined;
    const cancel = () => {
      child.kill("SIGTERM");
      force = setTimeout(() => child.kill("SIGKILL"), 100);
      force.unref();
    };
    signal.addEventListener("abort", cancel, { once: true });
    const seen = new Set<string>();
    let done = false;
    const send = (value: any) => {
      if (child.stdin.destroyed)
        throw Error("Mastra runtime stopped during tool execution");
      child.stdin.write(JSON.stringify(value) + "\n");
    };
    try {
      send({ type: "start", input });
      for await (const line of lines) {
        if (bytes(line) > 2 << 20)
          throw Error("invalid Mastra runtime response");
        let frame: RuntimeFrame;
        try {
          frame = JSON.parse(line);
        } catch {
          throw Error("invalid Mastra runtime response");
        }
        if (signal.aborted) {
          if (
            frame.type === "event" &&
            ["model.request.started", "turn.usage"].includes(frame.name || "")
          )
            await event(frame);
          continue;
        }
        if (frame.type === "tool.request") {
          if (
            !frame.id ||
            bytes(frame.id) > 256 ||
            seen.has(frame.id) ||
            !names.test(frame.name || "") ||
            !tool
          )
            throw Error("invalid Mastra tool request");
          seen.add(frame.id);
          let value: any;
          try {
            value = await tool(frame.name!, frame.input);
          } catch (error) {
            value = {
              error: error instanceof Error ? error.message : "tool failed",
            };
          }
          try {
            if (bytes(JSON.stringify(value)) > 128 << 10) throw Error();
          } catch {
            value = {
              error:
                "tool result is too large or cannot be encoded; narrow the query",
            };
          }
          signal.throwIfAborted();
          send({ type: "tool.response", id: frame.id, value });
        } else if (frame.type === "event") {
          if (
            !allowedEvents.has(frame.name || "") ||
            !frame.data ||
            typeof frame.data !== "object" ||
            Array.isArray(frame.data)
          )
            throw Error("invalid Mastra event");
          await event(frame);
        } else if (frame.type === "checkpoint" || frame.type === "compacted")
          await event(frame);
        else if (frame.type === "done") {
          done = true;
          break;
        } else if (frame.type === "error")
          throw new RuntimeError(frame.code || "provider_error");
        else throw Error("invalid Mastra runtime frame");
      }
      signal.throwIfAborted();
      if (spawnError)
        throw Error(
          "cannot start Mastra runtime; install Node.js >=22.13 or configure LIGHTMONI_AI_NODE",
        );
      if (!done) throw Error("Mastra runtime interrupted; retry this turn");
    } finally {
      signal.removeEventListener("abort", cancel);
      if (force) clearTimeout(force);
      lines.close();
      child.stdin.end();
      child.kill("SIGKILL");
      await exited;
    }
  };
}
export function pendingTools(messages: Message[]): ToolCall[] {
  const completed = new Set(
    messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id),
  );
  return messages
    .flatMap((m) => m.tool_calls || [])
    .filter((c) => !completed.has(c.id));
}
export function credential(value: any, secret: string): boolean {
  if (!secret) return false;
  const spelling = JSON.stringify(secret).slice(1, -1);
  if (typeof value === "string")
    return value.includes(secret) || value.includes(spelling);
  if (Array.isArray(value)) return value.some((v) => credential(v, secret));
  if (value && typeof value === "object")
    return Object.entries(value).some(
      ([k, v]) => credential(k, secret) || credential(v, secret),
    );
  return false;
}
export function checkpointCredential(
  messages: Message[],
  secret: string,
): boolean {
  if (!secret) return false;
  if (credential(publicSession({ messages } as any).messages, secret))
    return true;
  return messages.some((m) =>
    (m.tool_calls || []).some((call) => {
      try {
        return credential(JSON.parse(call.function.arguments), secret);
      } catch {
        return false;
      }
    }),
  );
}
function providerOptions(options: any): void {
  if (options == null) return;
  if (typeof options !== "object" || Array.isArray(options))
    throw Error("invalid assistant provider options");
  for (const [provider, fields] of Object.entries(options)) {
    if (
      !["google", "openai"].includes(provider) ||
      !fields ||
      typeof fields !== "object" ||
      Array.isArray(fields)
    )
      throw Error("invalid assistant provider options");
    for (const [field, value] of Object.entries(fields)) {
      if (
        !(
          (provider === "google" && field === "thoughtSignature") ||
          (provider === "openai" &&
            ["itemId", "reasoningEncryptedContent"].includes(field))
        ) ||
        typeof value !== "string" ||
        bytes(value) > 256 << 10
      )
        throw Error("invalid or oversized assistant provider options");
    }
  }
}
export function validateMetadata(messages: Message[]): void {
  if (!Array.isArray(messages)) throw Error("invalid assistant checkpoint");
  let total = 0;
  for (const message of messages) {
    for (const call of message.tool_calls || []) {
      providerOptions(call.provider_options);
      if (call.provider_options && Object.keys(call.provider_options).length)
        total += bytes(JSON.stringify(call.provider_options));
    }
    for (const state of message.provider_state || []) {
      if (
        message.role !== "assistant" ||
        !["text", "reasoning"].includes(state.type)
      )
        throw Error("invalid assistant provider state");
      if (state.type === "reasoning" && state.text)
        throw Error(
          "reasoning plaintext is not allowed in assistant provider state",
        );
      if (
        bytes(state.text || "") > 128 << 10 ||
        (state.type === "text" && !message.content.includes(state.text || ""))
      )
        throw Error("assistant signed text must match public message content");
      providerOptions(state.provider_options);
    }
    if (message.provider_state?.length)
      total += bytes(JSON.stringify(message.provider_state));
    if (total > 1 << 20)
      throw Error("assistant provider state exceeds its size limit");
  }
}
export function validateCheckpoint(
  messages: Message[],
  previous: number,
): void {
  if (!Array.isArray(messages) || messages.length < previous)
    throw Error("assistant checkpoint regressed");
  validateMetadata(messages);
  for (const m of messages) {
    if (
      !["assistant", "tool"].includes(m.role) ||
      typeof m.content !== "string"
    )
      throw Error("invalid assistant checkpoint role");
    if (bytes(m.content) > 128 << 10)
      throw Error("assistant checkpoint exceeds size limit");
    for (const call of m.tool_calls || []) {
      if (!call.id || !names.test(call.function?.name || ""))
        throw Error("invalid assistant checkpoint call");
      try {
        JSON.parse(call.function.arguments);
      } catch {
        throw Error("invalid assistant checkpoint call");
      }
    }
  }
  if (pendingTools(messages).length)
    throw Error("incomplete assistant tool checkpoint");
}
