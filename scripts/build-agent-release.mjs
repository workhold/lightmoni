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
if (!existsSync(join(repo, "runtime/dist/agent/main.js")))
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
      "https://nodejs.org/dist/v" + nodeVersion + "/" + file,
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
  const checksums = (await download("SHASUMS256.txt")).toString();
  const artifacts = [];
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
        node_version: nodeVersion,
        platform: "linux",
        arch,
        requires: "glibc >= 2.28",
        node_sha256: expected,
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
      "-czf",
      join(output, artifact),
      "-C",
      perArch,
      "lightmoni-agent",
      "lightmoni-agent.service",
      "lightmoni-agent-runtime",
    ]);
    artifacts.push(artifact);
  }
  for (const file of ["install.sh", "uninstall.sh", "config.example.json"])
    cpSync(join(repo, "deploy/agent", file), join(output, file));
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
