import type { ClickHouse as Contract } from "./types.js";
import { parseJSON, stringifyJSON } from "./json.js";
export class ClickHouse implements Contract {
  constructor(
    readonly endpoint: string,
    readonly user: string,
    readonly password: string,
    public database = "lightmoni",
  ) {}
  private async request(
    sql: string,
    params: Record<string, string>,
    data: string,
    reader: boolean,
    signal?: AbortSignal,
  ): Promise<string> {
    const url = new URL(this.endpoint);
    if (this.database) url.searchParams.set("database", this.database);
    url.searchParams.set("query", sql);
    if (reader)
      for (const [key, value] of Object.entries({
        max_execution_time: "10",
        max_memory_usage: "268435456",
        max_rows_to_read: "5000000",
        read_overflow_mode: "throw",
        max_result_rows: "10001",
        result_overflow_mode: "break",
        output_format_json_quote_64bit_integers: "1",
        output_format_json_quote_decimals: "1",
        output_format_json_quote_denormals: "0",
      }))
        url.searchParams.set(key, value);
    for (const [key, value] of Object.entries(params))
      url.searchParams.set("param_" + key, value);
    const response = await fetch(url, {
      method: "POST",
      body: data,
      headers: {
        authorization:
          "Basic " +
          Buffer.from(this.user + ":" + this.password).toString("base64"),
      },
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
        : AbortSignal.timeout(15000),
    });
    const chunks: Uint8Array[] = [];
    let length = 0;
    for await (const chunk of response.body ?? []) {
      length += chunk.length;
      if (length > 32 << 20) throw Error("ClickHouse response too large");
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString();
    if (!response.ok)
      throw Error("ClickHouse request failed (" + response.status + ")");
    return text;
  }
  async exec(sql: string, signal?: AbortSignal) {
    await this.request(sql, {}, "", false, signal);
  }
  async query(
    sql: string,
    params: Record<string, string> = {},
    signal?: AbortSignal,
  ) {
    return parseJSON<{
      meta: { name: string; type: string }[];
      data: Record<string, any>[];
      rows: number;
    }>(await this.request(sql + " FORMAT JSON", params, "", true, signal));
  }
  async insert(
    table: string,
    rows: Record<string, any>[],
    signal?: AbortSignal,
  ) {
    if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw Error("invalid insert table");
    if (rows.length)
      await this.request(
        "INSERT INTO " + table + " FORMAT JSONEachRow",
        {},
        rows.map((row) => stringifyJSON(row)).join("\n") + "\n",
        false,
        signal,
      );
  }
}
