import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { VERSION } from "./config.js";

export interface AgentRuntimeRelease {
  version: string;
  source_revision: string;
  build_id: string;
  state_schema: number;
  artifact_sha256: string;
}

/** Resolve relative to this process's actual module, never the mutable current
 * symlink. An old process must not advertise a newly installed program. */
export function readAgentRelease(directory = fileURLToPath(new URL("../../../../", import.meta.url))): AgentRuntimeRelease {
  const fallback = { version: VERSION, source_revision: "", build_id: "", state_schema: 1, artifact_sha256: "" };
  try {
    const manifest = JSON.parse(readFileSync(join(directory, "release.json"), "utf8"));
    if (typeof manifest.version !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(manifest.version)
      || !/^[a-f0-9]{40}$/.test(manifest.source_revision ?? "")
      || !/^[A-Za-z0-9._-]{1,128}$/.test(manifest.build_id ?? "")
      || manifest.state_schema !== 1 || manifest.platform !== "linux"
      || !["amd64", "arm64"].includes(manifest.arch)) return fallback;
    let artifact = "";
    try {
      const receipt = JSON.parse(readFileSync(join(directory, "installation.json"), "utf8"));
      if (receipt.schema === 1 && /^[a-f0-9]{64}$/.test(receipt.artifact_sha256 ?? "")) artifact = receipt.artifact_sha256;
    } catch { /* Source checkouts and old packages have no installation receipt. */ }
    return { version: manifest.version, source_revision: manifest.source_revision, build_id: manifest.build_id, state_schema: manifest.state_schema, artifact_sha256: artifact };
  } catch { return fallback; }
}
