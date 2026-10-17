/** Isolated durable receiver for the Go/native SDK integration tests. */
import { createInterface } from "node:readline";
import { createAgent } from "../../src/agent/agent.js";
import { defaultConfig } from "../../src/agent/config.js";
import { Queue } from "../../src/agent/queue.js";
const [directory, listen = "127.0.0.1:0"] = process.argv.slice(2);
if (!directory) throw Error("temporary Agent data directory required");
const config = {
  ...defaultConfig(),
  data_dir: directory,
  listen,
  endpoint: "http://127.0.0.1:1",
  key: "test-sdk-integration-key",
  min_free_bytes: 0,
  collect_interval_seconds: 3600,
};
const agent = createAgent(config),
  address = await agent.listen();
process.stdout.write(
  JSON.stringify({ url: "http://127.0.0.1:" + (address as any).port }) + "\n",
);
const input = createInterface({ input: process.stdin });
for await (const command of input) {
  if (command === "stop") break;
}
input.close();
await agent.close();
const queue = new Queue(config),
  batches: any[] = [];
try {
  for (;;) {
    const batch = queue.next();
    if (!batch) break;
    batches.push({ ...batch, payload: batch.payload.toString("base64") });
    queue.complete(batch.id);
  }
} finally {
  queue.close();
}
process.stdout.write(JSON.stringify({ batches }) + "\n");
