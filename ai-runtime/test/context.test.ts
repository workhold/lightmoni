import { test } from "node:test";
import assert from "node:assert/strict";
import { compactionPlan, estimate, toModelMessages } from "../src/context.js";
import type { Message } from "../src/protocol.js";

test("compaction cuts complete user-led rounds and retains the newest request", () => {
  const messages: Message[] = [
    { role: "user", content: "old".repeat(3000) },
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "c",
          type: "function",
          function: { name: "list_tables", arguments: "{}" },
        },
      ],
    },
    { role: "tool", content: "{}", tool_call_id: "c" },
    { role: "assistant", content: "old answer" },
    { role: "user", content: "recent" },
    { role: "assistant", content: "recent answer" },
    { role: "user", content: "latest" },
  ];
  const plan = compactionPlan(messages, 0, "", "system", [], 4096);
  assert.equal(plan.through, 4);
  assert.equal(plan.keep.at(-1)?.content, "latest");
  assert.deepEqual(plan.keep, messages.slice(4));
  assert.equal(toModelMessages(messages)[2].role, "tool");
});

test("latest request cannot be silently truncated", () => {
  assert.throws(
    () =>
      compactionPlan(
        [{ role: "user", content: "x".repeat(10000) }],
        0,
        "",
        "s",
        [],
        4096,
      ),
    /context_limit/,
  );
});

test("small history is unchanged and UTF-8 estimate is conservative", () => {
  const m: Message[] = [{ role: "user", content: "你好" }];
  assert.equal(compactionPlan(m, 0, "", "s", [], 4096).through, 0);
  assert.ok(estimate(m) >= Buffer.byteLength(JSON.stringify(m)));
});

test("image and PDF attachments reach the model without treating base64 as text tokens", () => {
  const data = "a".repeat(600_000);
  const messages: Message[] = [{ role: "user", content: "Explain these", attachments: [
    { kind: "image", name: "screen.jpg", mime_type: "image/jpeg", data },
    { kind: "pdf", name: "report.pdf", mime_type: "application/pdf", pages: 2, text: "observed report values" },
  ] }];
  const [model] = toModelMessages(messages);
  assert.equal(model.content[0].text, "Explain these");
  assert.equal(model.content[1].type, "image");
  assert.equal(model.content[1].image, `data:image/jpeg;base64,${data}`);
  assert.match(model.content[2].text, /observed report values/);
  assert.ok(estimate(messages) < 10000);
});
