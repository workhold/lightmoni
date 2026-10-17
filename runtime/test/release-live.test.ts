import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  lstatSync,
  readlinkSync,
  existsSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname, isAbsolute, sep } from "node:path";

const release = process.env.LIGHTMONI_RELEASE_DIR;
test(
  "Linux release bundles contain checked architecture, portable dependencies and a working launcher",
  { skip: !release, timeout: 30000 },
  () => {
    const root = mkdtempSync(join(tmpdir(), "lightmoni-release-check-"));
    const checksum = readFileSync(join(release!, "SHA256SUMS"), "utf8");
    try {
      for (const arch of ["amd64", "arm64"]) {
        const artifact = readdirSync(release!).find((name) =>
          name.endsWith("_linux_" + arch + ".tar.gz"),
        )!;
        assert(artifact);
        const hash = createHash("sha256")
          .update(readFileSync(join(release!, artifact)))
          .digest("hex");
        assert(checksum.includes(hash + "  " + artifact));
        const dest = join(root, arch);
        execFileSync("mkdir", ["-p", dest]);
        execFileSync("tar", ["-xzf", join(release!, artifact), "-C", dest]);
        const runtime = join(dest, "lightmoni-agent-runtime"),
          metadata = JSON.parse(
            readFileSync(join(runtime, "release.json"), "utf8"),
          );
        assert.equal(metadata.arch, arch);
        assert.equal(metadata.node_version, "24.15.0");
        assert(existsSync(join(runtime, "NODE-LICENSE")));
        const binary = readFileSync(join(runtime, "node"));
        assert.equal(binary.subarray(0, 4).toString("hex"), "7f454c46");
        assert.equal(binary.readUInt16LE(18), arch === "amd64" ? 62 : 183);
        const walk = (path: string) => {
          for (const name of readdirSync(path)) {
            const file = join(path, name),
              info = lstatSync(file);
            if (info.isSymbolicLink()) {
              const link = readlinkSync(file),
                target = resolve(dirname(file), link);
              assert(!isAbsolute(link));
              assert(target.startsWith(dest + sep));
              assert(existsSync(target), file);
            } else if (info.isDirectory()) walk(file);
          }
        };
        walk(dest);
        // The Linux binary cannot execute on macOS. Exercise the packaged JS and
        // launcher with the host Node, after separately checking the ELF above.
        rmSync(join(runtime, "node"));
        symlinkSync(process.execPath, join(runtime, "node"));
        const launcher = join(dest, "lightmoni-agent");
        assert.equal(
          execFileSync("sh", [launcher, "version"], {
            encoding: "utf8",
          }).trim(),
          "0.1.0",
        );
        const config = join(dest, "config.json");
        writeFileSync(
          config,
          JSON.stringify({
            endpoint: "http://127.0.0.1:1",
            key: "release-fixture",
            listen: "127.0.0.1:4318",
            data_dir: join(dest, "state"),
          }),
        );
        assert.match(
          execFileSync("sh", [launcher, "check", "--config", config], {
            encoding: "utf8",
          }),
          /configuration valid/,
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
