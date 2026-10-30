import { test } from "node:test";
import assert from "node:assert/strict";
import { agentUpdateTools, type AgentUpdateAssistantStore } from "../src/assistant/agent-updates.js";

test("AI update tools only draft a pinned review and query receipts; no execution surface", async () => {
  const calls: any[] = [], sha = "a".repeat(64), signal = new AbortController().signal;
  const store: AgentUpdateAssistantStore = {
    listReleases: () => [{ version: "0.1.0", sha256: sha }],
    assistantPlan: async (...args) => { calls.push(args); return { id: "u1", status: "awaiting_approval", review_url: "/machines?machine=m1&update=u1" }; },
    assistantGet: () => ({ id: "u1", status: "unknown" }),
  };
  const tools = agentUpdateTools(store), admin = { id: "alice", role: "admin" };
  assert.deepEqual(tools.map(t => [t.name, t.effect]), [["list_agent_releases", "read"], ["propose_agent_update", "draft"], ["get_agent_update", "read"]]);
  assert.equal((await tools[0].execute({}, signal, admin)).releases[0].sha256, sha);
  const proposal = await tools[1].execute({ machine_id: "m1", action: "upgrade", target_sha256: sha }, signal, admin);
  assert.equal(proposal.status, "awaiting_approval");
  assert.deepEqual(calls[0], ["m1", { action: "upgrade", target_sha256: sha }, "alice", signal]);
  await tools[1].execute({ machine_id: "m1", action: "rollback", credential_id: "c1" }, signal, admin);
  assert.deepEqual(calls[1][1], { action: "rollback", credential_id: "c1" });
  assert.equal((await tools[2].execute({ machine_id: "m1", update_id: "u1" }, signal, admin)).status, "unknown");
});

test("AI update tools reject members, command injection fields, and unpinned releases before invoking store", async () => {
  let invoked = 0;
  const store: AgentUpdateAssistantStore = { listReleases: () => { invoked++; return []; }, assistantPlan: async () => { invoked++; return {}; }, assistantGet: () => { invoked++; return {}; } };
  const tools = agentUpdateTools(store), signal = new AbortController().signal, admin = { id: "alice", role: "admin" };
  for (const tool of tools) await assert.rejects(tool.execute({}, signal, { id: "member", role: "member" }), /administrator required/);
  await assert.rejects(tools[0].execute({ command: "env" }, signal, admin), /invalid input/);
  for (const input of [
    { machine_id: "m1", action: "upgrade" },
    { machine_id: "m1", action: "upgrade", target_sha256: "latest" },
    { machine_id: "m1", action: "rollback", target_sha256: "a".repeat(64) },
    { machine_id: "m1", action: "upgrade", target_sha256: "a".repeat(64), confirm: true },
    { machine_id: "m1", action: "shell", command: "id" },
  ]) await assert.rejects(tools[1].execute(input, signal, admin));
  assert.equal(invoked, 0);
});
