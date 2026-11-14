import { fail } from "../shared/http.js";
import type { Logs } from "./logs.js";

export const LOG_CAPABILITY_BYTES = 60 << 10;
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value) ?? "");

/** Model-facing bounded projection over the real owner-bound frozen log session. */
export class LogReadService {
  constructor(private readonly logs: Logs) {}
  async search(input: any, ownerID: string, signal: AbortSignal) {
    if (input?.limit != null && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 200)) fail(400, "invalid_input");
    const result = await this.logs.searchRead({...input, limit: input.limit ?? 50}, ownerID, signal);
    const output: any = structuredClone(result);
    output.capability_truncated = false;
    while (size(output) > LOG_CAPABILITY_BYTES) {
      if (output.frame.rows.length > 1) {
        output.frame.rows = output.frame.rows.slice(0, -Math.max(1, Math.ceil(output.frame.rows.length / 4)));
        output.truncated = true; output.capability_truncated = true;
        const next = output.offset + output.frame.rows.length;
        output.next_cursor = next < output.total_loaded ? String(next) : "";
        continue;
      }
      if (output.histogram?.rows?.length > 1) {
        output.histogram.rows = output.histogram.rows.slice(0, -Math.max(1, Math.ceil(output.histogram.rows.length / 4)));
        output.histogram_truncated = true; output.capability_truncated = true;
        continue;
      }
      break;
    }
    if (size(output) > LOG_CAPABILITY_BYTES) fail(413, "result_too_large");
    return output;
  }
}
