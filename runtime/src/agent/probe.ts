import { createConnection } from "node:net";
import { listenAddress, type Probe } from "./config.js";
export interface ProbeResult {
  success: boolean;
  duration: number;
  reason: string;
  status: number;
}
export async function checkProbe(
  p: Probe,
  parent?: AbortSignal,
): Promise<ProbeResult> {
  const started = performance.now(),
    signal = parent
      ? AbortSignal.any([parent, AbortSignal.timeout(p.timeout_ms)])
      : AbortSignal.timeout(p.timeout_ms),
    result: ProbeResult = {
      success: false,
      duration: 0,
      reason: "ok",
      status: 0,
    };
  try {
    if (p.kind === "tcp") {
      const { host, port } = listenAddress(p.target);
      await new Promise<void>((resolve, reject) => {
        const socket = createConnection({ host, port, signal });
        socket.once("connect", () => {
          socket.destroy();
          resolve();
        });
        socket.once("error", reject);
      });
      result.success = true;
    } else {
      let url = p.target;
      for (let i = 0; ; i++) {
        const response = await fetch(url, { redirect: "manual", signal });
        if (
          [301, 302, 303, 307, 308].includes(response.status) &&
          response.headers.has("location")
        ) {
          await response.body?.cancel();
          if (i >= 4) throw Error("redirect limit");
          const next = new URL(response.headers.get("location")!, url);
          if (!["http:", "https:"].includes(next.protocol))
            throw Error("redirect protocol");
          url = next.href;
          continue;
        }
        result.status = response.status;
        const reader = response.body?.getReader();
        if (reader) {
          try {
            let bytes = 0;
            while (bytes < 4096) {
              const item = await reader.read();
              if (item.done) break;
              bytes += item.value.length;
            }
          } finally {
            await reader.cancel();
          }
        }
        result.success = p.expected_status?.length
          ? p.expected_status.includes(result.status)
          : result.status >= 200 && result.status < 400;
        if (!result.success) result.reason = "unexpected_status";
        break;
      }
    }
  } catch (error) {
    const e = error as any,
      cause = e.cause ?? e;
    if (
      signal.aborted ||
      e.name === "TimeoutError" ||
      cause.code === "ETIMEDOUT"
    )
      result.reason = "timeout";
    else if (["ENOTFOUND", "EAI_AGAIN"].includes(cause.code))
      result.reason = "dns";
    else if (/tls|certificate/i.test(String(cause))) result.reason = "tls";
    else result.reason = "connection";
  }
  result.duration = (performance.now() - started) / 1000;
  return result;
}
