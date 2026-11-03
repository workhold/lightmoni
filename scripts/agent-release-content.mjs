import { relative, sep } from "node:path";

export const EXCLUDED_AGENT_RUNTIME_ENTRIES = Object.freeze([
  "server/executor-absence-shell.js",
  "server/machine-executor-bootstrap.js",
  "server/machine-executor-maintenance.js",
  "privileged-executor/activation.js",
  "privileged-executor/cli.js",
  "privileged-executor/main.js",
]);

const excluded = new Set(EXCLUDED_AGENT_RUNTIME_ENTRIES);
const entryPath = (value) => value.split(sep).join("/");

export function includeAgentRuntimeEntry(source, runtimeDistRoot) {
  return !excluded.has(entryPath(relative(runtimeDistRoot, source)));
}

export function includeAgentRuntimeHashEntry(relativeToRepository) {
  const prefix = "runtime/dist/";
  return !relativeToRepository.startsWith(prefix) || !excluded.has(relativeToRepository.slice(prefix.length));
}
