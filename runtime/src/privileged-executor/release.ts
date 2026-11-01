import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { boundedFile, refuse } from "./security.js";
import { parseStrictJSON, strictRecord } from "../shared/privileged-executor.js";

export function readExecutorRelease() {
  const directory = fileURLToPath(new URL("../../../../", import.meta.url));
  const required = ["version", "source_revision", "build_id", "state_schema", "platform", "arch"];
  const release = strictRecord(parseStrictJSON(boundedFile(join(directory, "release.json"), 8192)), [...required, "build_time", "node_version", "requires", "node_sha256", "node_binary_sha256"], required);
  const receipt = strictRecord(parseStrictJSON(boundedFile(join(directory, "installation.json"), 8192)), ["schema", "artifact_sha256"]);
  if (typeof release.version !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(release.version) || !/^[a-f0-9]{40}$/.test(release.source_revision)
    || !/^[A-Za-z0-9._-]{1,128}$/.test(release.build_id) || release.state_schema !== 1 || release.platform !== "linux" || !["amd64", "arm64"].includes(release.arch)
    || receipt.schema !== 1 || !/^[a-f0-9]{64}$/.test(receipt.artifact_sha256)) refuse("invalid_executor_release");
  return { version: release.version as string, release: { build_id: release.build_id as string, source_revision: release.source_revision as string, artifact_sha256: receipt.artifact_sha256 as string, state_schema: 1 as const } };
}
