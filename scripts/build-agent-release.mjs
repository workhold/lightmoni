#!/usr/bin/env node
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  renameSync,
  existsSync,
  chmodSync,
  readdirSync,
  lstatSync,
  readlinkSync,
} from "node:fs";
import { resolve, join, dirname, sep, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
const repo = resolve(fileURLToPath(new URL("..", import.meta.url))),
  version = process.argv[2] ?? "0.1.0",
  output = resolve(process.argv[3] ?? join(repo, "runtime/downloads")),
  nodeVersion = "24.15.0";
if (!/^[0-9A-Za-z._-]+$/.test(version)) throw Error("Invalid fixed version");
let sourceRevision = process.env.LIGHTMONI_BUILD_REVISION || process.env.LIGHTMONI_SOURCE_REVISION;
if (!sourceRevision) {
  try { sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { throw Error("Agent releases require LIGHTMONI_BUILD_REVISION (the full Git commit SHA)"); }
}
if (!/^[a-f0-9]{40}$/.test(sourceRevision)) throw Error("Invalid source revision");
// Content identity also distinguishes an intentional dirty/source-only build
// at the same commit. File order is stable and timestamps are excluded.
const contentHash = createHash("sha256");
function hashTree(location, relative = "") {
  const info = lstatSync(location);
  contentHash.update(relative + "\0");
  if (info.isSymbolicLink()) contentHash.update("link\0" + readlinkSync(location));
  else if (info.isDirectory()) for (const name of readdirSync(location).sort()) hashTree(join(location, name), relative + "/" + name);
  else contentHash.update(readFileSync(location));
}
for (const file of ["runtime/dist", "runtime/package.json", "runtime/package-lock.json", "sdk/typescript/dist", "sdk/typescript/package.json", "deploy/agent", "deploy/executor", "scripts/build-agent-release.mjs"]) hashTree(join(repo, file), file);
const buildID = process.env.LIGHTMONI_AGENT_BUILD_ID ?? `${version}-${sourceRevision.slice(0, 12)}-${contentHash.digest("hex").slice(0, 12)}`;
if (!/^[A-Za-z0-9._-]{1,128}$/.test(buildID)) throw Error("Invalid Agent build ID");
const buildTime = new Date().toISOString();
const officialNodeDistribution = "https://nodejs.org/dist";
let nodeDistribution;
try {
  const url = new URL(process.env.LIGHTMONI_NODE_DIST_URL ?? officialNodeDistribution);
  if (url.protocol !== "https:" || url.username || url.password || url.href.includes("?") || url.href.includes("#"))
    throw Error();
  nodeDistribution = url.href.replace(/\/+$/, "");
} catch {
  throw Error("Node distribution URL must use HTTPS without credentials, query or fragment");
}
if (!existsSync(join(repo, "runtime/dist/agent/main.js")) || !existsSync(join(repo, "runtime/dist/privileged-executor/main.js")))
  throw Error("Build the TypeScript SDK and runtime first");
mkdirSync(output, { recursive: true });
const staging = mkdtempSync(join(tmpdir(), "lightmoni-release-")),
  cache = resolve(
    process.env.LIGHTMONI_NODE_CACHE ?? join(repo, ".local-dev/node-releases"),
  );
mkdirSync(cache, { recursive: true });
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function download(file) {
  console.info("Downloading pinned Node release: " + file);
  return execFileSync(
    "curl",
    [
      "--fail",
      "--silent",
      "--show-error",
      "--location",
      "--max-time",
      "120",
      (file === "SHASUMS256.txt" ? officialNodeDistribution : nodeDistribution) + "/v" + nodeVersion + "/" + file,
    ],
    { maxBuffer: 128 << 20 },
  );
}
try {
  const common = join(staging, "common"),
    app = join(common, "lightmoni-agent-runtime/app"),
    runtime = join(app, "runtime"),
    sdk = join(app, "sdk/typescript");
  mkdirSync(runtime, { recursive: true });
  mkdirSync(sdk, { recursive: true });
  for (const name of ["package.json", "package-lock.json"])
    cpSync(join(repo, "runtime", name), join(runtime, name));
  cpSync(join(repo, "runtime/dist"), join(runtime, "dist"), {
    recursive: true,
  });
  cpSync(join(repo, "sdk/typescript/package.json"), join(sdk, "package.json"));
  cpSync(join(repo, "sdk/typescript/dist"), join(sdk, "dist"), {
    recursive: true,
  });
  execFileSync(
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["ci", "--omit=dev", "--ignore-scripts"],
    { cwd: runtime, stdio: "inherit" },
  );
  // This directory is self-contained; no global Node or npm is needed on a node.
  cpSync(
    join(repo, "deploy/agent/launcher.sh"),
    join(common, "lightmoni-agent"),
  );
  chmodSync(join(common, "lightmoni-agent"), 0o755);
  cpSync(
    join(repo, "deploy/agent/lightmoni-agent.service"),
    join(common, "lightmoni-agent.service"),
  );
  // Keep an offline maintenance entry point inside the checked runtime bundle.
  // It requires neither the platform nor a working bundled Node executable.
  cpSync(join(repo, "deploy/agent/uninstall.sh"), join(common, "lightmoni-agent-runtime/uninstall.sh"));
  chmodSync(join(common, "lightmoni-agent-runtime/uninstall.sh"), 0o755);
  // One immutable release carries both fixed roles. Installing the ordinary
  // Agent does not enroll or enable the privileged executor.
  cpSync(join(repo, "deploy/executor"), join(common, "lightmoni-agent-runtime/executor"), { recursive: true });
  for (const script of ["install.sh", "launcher.sh", "uninstall.sh", "upgrade.sh"])
    chmodSync(join(common, "lightmoni-agent-runtime/executor", script), 0o755);
  cpSync(join(repo, "deploy/agent/deployment-permissions.mjs"), join(common, "lightmoni-agent-runtime/deployment-permissions.mjs"));
  const checksums = (await download("SHASUMS256.txt")).toString();
  const artifacts = [];
  const releases = [];
  for (const [arch, nodeArch] of [
    ["amd64", "x64"],
    ["arm64", "arm64"],
  ]) {
    const nodeFile = `node-v${nodeVersion}-linux-${nodeArch}.tar.xz`,
      expected = checksums
        .split("\n")
        .find((line) => line.endsWith("  " + nodeFile))
        ?.split(/\s+/)[0];
    if (!/^[0-9a-f]{64}$/.test(expected ?? ""))
      throw Error("Node release checksum missing");
    const local = join(cache, nodeFile);
    let archive = existsSync(local)
      ? readFileSync(local)
      : await download(nodeFile);
    if (sha(archive) !== expected)
      throw Error("Node release checksum mismatch for " + nodeFile);
    if (!existsSync(local)) {
      writeFileSync(local + ".tmp", archive);
      renameSync(local + ".tmp", local);
    }
    const perArch = join(staging, arch);
    cpSync(common, perArch, { recursive: true, verbatimSymlinks: true });
    const extracted = join(staging, "node-" + arch);
    mkdirSync(extracted);
    execFileSync("tar", [
      "-xJf",
      local,
      "-C",
      extracted,
      "--strip-components=1",
    ]);
    const target = join(perArch, "lightmoni-agent-runtime");
    cpSync(join(extracted, "bin/node"), join(target, "node"));
    chmodSync(join(target, "node"), 0o755);
    cpSync(join(extracted, "LICENSE"), join(target, "NODE-LICENSE"));
    writeFileSync(
      join(target, "release.json"),
      JSON.stringify({
        version,
        source_revision: sourceRevision,
        build_id: buildID,
        build_time: buildTime,
        state_schema: 1,
        node_version: nodeVersion,
        platform: "linux",
        arch,
        requires: "glibc >= 2.28",
        node_sha256: expected,
        node_binary_sha256: sha(readFileSync(join(target, "node"))),
      }) + "\n",
    );
    const elf = readFileSync(join(target, "node"));
    if (
      elf.subarray(0, 4).toString("hex") !== "7f454c46" ||
      elf.readUInt16LE(18) !== (arch === "amd64" ? 62 : 183)
    )
      throw Error("Node executable architecture mismatch");
    validateLinks(perArch);
    const artifact = `lightmoni-agent_${version}_linux_${arch}.tar.gz`;
    execFileSync("tar", [
      "--no-xattrs",
      "--no-acls",
      "-czf",
      join(output, artifact),
      "-C",
      perArch,
      "lightmoni-agent",
      "lightmoni-agent.service",
      "lightmoni-agent-runtime",
    ], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
    artifacts.push(artifact);
    const packedArchive = readFileSync(join(output, artifact));
    releases.push({ version, source_revision: sourceRevision, build_id: buildID, state_schema: 1, platform: "linux", arch, file: artifact, sha256: sha(packedArchive), size: packedArchive.length, build_time: buildTime });
  }
  for (const file of ["install.sh", "uninstall.sh", "update.sh", "update-runner.mjs", "config.example.json"])
    cpSync(join(repo, "deploy/agent", file), join(output, file));
  writeFileSync(join(output, "agent-releases.json"), JSON.stringify({ schema: 1, releases, recommended_by_arch: Object.fromEntries(releases.map(release => [release.arch, release.sha256])) }, null, 2) + "\n");
  writeFileSync(
    join(output, "SHA256SUMS"),
    artifacts
      .map((file) => sha(readFileSync(join(output, file))) + "  " + file)
      .join("\n") + "\n",
  );
  console.info("LightMoni Agent Node bundles created in " + output);
} finally {
  rmSync(staging, { recursive: true, force: true });
}

function validateLinks(root) {
  for (const name of readdirSync(root)) {
    const path = join(root, name),
      info = lstatSync(path);
    if (info.isSymbolicLink()) {
      const link = readlinkSync(path),
        target = resolve(dirname(path), link);
      if (
        isAbsolute(link) ||
        !target.startsWith(staging + sep) ||
        !existsSync(target)
      )
        throw Error("Release contains a nonportable dependency link: " + path);
    } else if (info.isDirectory()) validateLinks(path);
  }
}
