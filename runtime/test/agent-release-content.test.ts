import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  EXCLUDED_AGENT_RUNTIME_ENTRIES,
  includeAgentRuntimeEntry,
  includeAgentRuntimeHashEntry,
} from "../../scripts/agent-release-content.mjs";

test("Agent release excludes retired standalone lifecycle modules from copied and hashed runtime trees", () => {
  const root = "/repo/runtime/dist";
  for (const entry of EXCLUDED_AGENT_RUNTIME_ENTRIES) {
    assert.equal(includeAgentRuntimeEntry(join(root, entry), root), false, entry);
    assert.equal(includeAgentRuntimeHashEntry(`runtime/dist/${entry}`), false, entry);
  }
  assert.equal(includeAgentRuntimeEntry(join(root, "agent/main.js"), root), true);
  assert.equal(includeAgentRuntimeHashEntry("runtime/dist/agent/main.js"), true);
  assert.equal(includeAgentRuntimeHashEntry("runtime/dist/server/app.js"), true);
});
