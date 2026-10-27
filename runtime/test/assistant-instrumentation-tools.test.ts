import { test } from "node:test";
import assert from "node:assert/strict";
import type { Dependencies } from "../src/shared/types.js";
import { monitoringTools } from "../src/assistant/tools.js";

test("propose_sdk_instrumentation returns a reviewable plan without applying files", async () => {
  let proposed: any;
  const plan = {
    plan_id: "ip_fixture",
    workspace: "checkout",
    base_revision: "sha256:fixture",
    state: "awaiting_approval",
    intent: "add request and error metrics",
    files: [
      {
        path: "src/http.ts",
        summary: "wrap the request handler with SDK timing",
        patch: "@@ -1 +1 @@",
        risks: ["confirm route does not contain sensitive payloads"],
        validation_steps: ["npm test"],
      },
    ],
    manual_steps: [],
    warnings: [],
    validation_steps: ["npm test"],
  };
  const instrumentation = {
    scan: async () => ({ plan_id: "scan_fixture" }),
    propose: async (input: any) => {
      proposed = input;
      return plan;
    },
  };
  const tools = monitoringTools({} as Dependencies, {
    instrumentation: instrumentation as any,
  });
  const tool = tools.find((item) => item.name === "propose_sdk_instrumentation");
  assert.ok(tool);
  assert.equal(tool.effect, "draft");
  const result = await tool.execute(
    {
      workspace: " checkout ",
      intent: " add request and error metrics ",
      base_revision: " sha256:fixture ",
      service: "checkout",
      env: "production",
      mode: "direct",
      table: "service_metrics",
      metric: "http.request.duration",
    },
    new AbortController().signal,
    { id: "alice", role: "admin" },
  );
  assert.equal(result.state, "awaiting_approval");
  assert.equal(result.files[0].path, "src/http.ts");
  assert.deepEqual(proposed, {
    workspace: "checkout",
    intent: "add request and error metrics",
    base_revision: "sha256:fixture",
    service: "checkout",
    env: "production",
    mode: "direct",
    table: "service_metrics",
    metric: "http.request.duration",
  });
  assert.deepEqual(
    tools.filter((item) => item.name.includes("instrumentation")).map((item) => item.name),
    ["scan_sdk_instrumentation", "propose_sdk_instrumentation"],
  );
});

test("propose_sdk_instrumentation rejects non-admins, unknown fields and invalid modes", async () => {
  const instrumentation = {
    scan: async () => ({}),
    propose: async () => ({}),
  };
  const tool = monitoringTools({} as Dependencies, {
    instrumentation: instrumentation as any,
  }).find((item) => item.name === "propose_sdk_instrumentation")!;
  await assert.rejects(
    tool.execute(
      { workspace: ".", intent: "add metrics" },
      new AbortController().signal,
      { id: "member", role: "member" },
    ),
    /administrator required/,
  );
  await assert.rejects(
    tool.execute(
      { workspace: ".", intent: "add metrics", unknown: true },
      new AbortController().signal,
      { id: "alice", role: "admin" },
    ),
    /invalid input/,
  );
  await assert.rejects(
    tool.execute(
      { workspace: ".", intent: "add metrics", mode: "automatic" },
      new AbortController().signal,
      { id: "alice", role: "admin" },
    ),
    /invalid tool input/,
  );
});

test("get_service_deployment_events returns only the sanitized deployment timeline", async () => {
  const deployments = {
    assistantServices: () => [],
    assistantPlan: () => ({}),
    assistantDeployment: () => ({ id: "dep_1", status: "agent_ready" }),
    assistantDeploymentEvents: (deploymentID: string) => [
      { id: "event_1", deployment_id: deploymentID, state: "awaiting_approval", summary: "计划已生成" },
      { id: "event_2", deployment_id: deploymentID, state: "agent_ready", summary: "已批准，等待 Agent" },
    ],
  };
  const tools = monitoringTools({} as Dependencies, { deployments: deployments as any });
  const tool = tools.find((item) => item.name === "get_service_deployment_events");
  assert.ok(tool);
  const result = await tool.execute(
    { deployment_id: "dep_1" },
    new AbortController().signal,
    { id: "alice", role: "admin" },
  );
  assert.equal(result.deployment_id, "dep_1");
  assert.deepEqual(result.events.map((event: any) => event.state), ["awaiting_approval", "agent_ready"]);
  await assert.rejects(
    tool.execute(
      { deployment_id: "dep_1" },
      new AbortController().signal,
      { id: "member", role: "member" },
    ),
    /administrator required/,
  );
});
