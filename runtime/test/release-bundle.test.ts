import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { parseReleaseBundle } from "../src/deployment/release-bundle.js";

type Entry = {
  name: string;
  content?: Buffer | string;
  type?: "file" | "directory" | "symlink" | "hardlink" | "device" | "fifo" | "sparse" | "extension";
  mode?: number;
  linkName?: string;
  prefix?: string;
  corruptChecksum?: boolean;
  declaredSize?: number;
};

const manifest = (overrides: Record<string, unknown> = {}) => Buffer.from(JSON.stringify({
  schema_version: 1,
  service_id: "a".repeat(32),
  version: "2026.10.22-1",
  architecture: "linux-amd64",
  source_revision: "git:0123456789abcdef",
  entrypoint: "run",
  ...overrides,
}));

function octal(value: number, length: number): Buffer {
  const result = Buffer.alloc(length);
  const text = value.toString(8).padStart(length - 1, "0") + "\0";
  result.write(text, 0, "ascii");
  return result;
}

function makeEntry(entry: Entry): Buffer[] {
  const header = Buffer.alloc(512);
  const name = Buffer.from(entry.name);
  assert.ok(name.length <= 100, "fixture path name must fit the USTAR name field");
  name.copy(header, 0);
  octal(entry.mode ?? (entry.name === "run" ? 0o755 : 0o644), 8).copy(header, 100);
  octal(0, 8).copy(header, 108);
  octal(0, 8).copy(header, 116);
  const content = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content ?? "");
  octal(entry.declaredSize ?? content.length, 12).copy(header, 124);
  octal(0, 12).copy(header, 136);
  header.fill(0x20, 148, 156);
  const typeFlag = entry.type === "directory" ? "5"
    : entry.type === "symlink" ? "2"
      : entry.type === "hardlink" ? "1"
          : entry.type === "device" ? "3"
            : entry.type === "fifo" ? "6"
              : entry.type === "sparse" ? "S"
        : entry.type === "extension" ? "x" : "0";
  header[156] = typeFlag.charCodeAt(0);
  if (entry.linkName) Buffer.from(entry.linkName).copy(header, 157);
  Buffer.from("ustar\0", "binary").copy(header, 257);
  Buffer.from("00", "ascii").copy(header, 263);
  if (entry.prefix) Buffer.from(entry.prefix).copy(header, 345);
  const sum = header.reduce((total, byte) => total + byte, 0);
  Buffer.from(sum.toString(8).padStart(6, "0") + "\0 ", "ascii").copy(header, 148);
  if (entry.corruptChecksum) header[0] = header[0]! ^ 1;
  const padding = Buffer.alloc((512 - (content.length % 512)) % 512);
  return [header, content, padding];
}

function bundle(entries: Entry[]): Buffer {
  return gzipSync(Buffer.concat([...entries.flatMap(makeEntry), Buffer.alloc(1024)]));
}

const validEntries = (overrides: Entry[] = []): Entry[] => [
  { name: "manifest.json", content: manifest() },
  { name: "run", content: "#!/bin/sh\necho hello\n", mode: 0o755 },
  ...overrides,
];

test("parses valid gzip USTAR bundle and preserves regular files", () => {
  const result = parseReleaseBundle(bundle(validEntries([
    { name: "config/default.json", content: "{}" },
    { name: "config", type: "directory", mode: 0o755 },
  ])));
  assert.equal(result.manifest.version, "2026.10.22-1");
  assert.equal(result.manifest.entrypoint, "run");
  assert.equal(result.files.find((file) => file.path === "run")?.mode, 0o755);
  assert.equal(result.files.find((file) => file.path === "config/default.json")?.content.toString(), "{}");
  assert.ok(result.expandedBytes > 1024);
});

test("limits total entries so directories cannot bypass the bundle cap", () => {
  const directories = Array.from({ length: 10_001 }, (_, index) => ({ name: `empty-${index}`, type: "directory" as const }));
  assert.throws(() => parseReleaseBundle(bundle(validEntries(directories))), /10,000 total entries/);
});

test("rejects path traversal, absolute paths, duplicate names, and conflicting parents", () => {
  for (const path of ["../outside", "/absolute", "a/../../outside", "a//b", "a/./b", "C:/outside"]) {
    assert.throws(() => parseReleaseBundle(bundle(validEntries([{ name: path, content: "x" }]))), /path/);
  }
  assert.throws(() => parseReleaseBundle(bundle(validEntries([
    { name: "run", content: "second", mode: 0o755 },
  ]))), /duplicate path/);
  assert.throws(() => parseReleaseBundle(bundle(validEntries([
    { name: "tree/leaf", content: "x" },
    { name: "tree", content: "not a directory" },
  ]))), /conflicts with an existing directory/);
});

test("rejects symlinks, hard links, devices, sparse files, and USTAR extensions", () => {
  for (const type of ["symlink", "hardlink", "device", "fifo", "sparse", "extension"] as const) {
    assert.throws(() => parseReleaseBundle(bundle(validEntries([{ name: "link", type, linkName: "run" }]))), /not allowed/);
  }
});

test("rejects a bad USTAR checksum and a non-USTAR header", () => {
  assert.throws(() => parseReleaseBundle(bundle([
    { name: "manifest.json", content: manifest(), corruptChecksum: true },
    { name: "run", content: "x", mode: 0o755 },
  ])), /checksum mismatch/);
  const data = Buffer.concat([...makeEntry({ name: "manifest.json", content: manifest() }), ...makeEntry({ name: "run", content: "x", mode: 0o755 }), Buffer.alloc(1024)]);
  data[257] = 0x67; // GNU tar magic rather than POSIX USTAR.
  assert.throws(() => parseReleaseBundle(gzipSync(data)), /non-USTAR/);
});

test("requires an executable regular root run file and a regular root manifest", () => {
  assert.throws(() => parseReleaseBundle(bundle([
    { name: "manifest.json", content: manifest() },
    { name: "run", content: "x", mode: 0o644 },
  ])), /execute bit/);
  assert.throws(() => parseReleaseBundle(bundle([
    { name: "manifest.json", content: "", type: "directory" },
    { name: "run", content: "x", mode: 0o755 },
  ])), /missing regular manifest/);
});

test("validates the exact manifest schema and rejects duplicate JSON fields", () => {
  const invalidManifests = [
    manifest({ schema_version: 2 }),
    manifest({ service_id: "not-a-service-id" }),
    manifest({ version: "../escape" }),
    manifest({ architecture: "darwin-arm64" }),
    manifest({ entrypoint: "bin/run" }),
    manifest({ extra: true }),
    manifest({ source_revision: "x".repeat(257) }),
    Buffer.from('{"schema_version":1,"schema_version":1,"service_id":"' + "a".repeat(32) + '","version":"v1","architecture":"any","source_revision":"r","entrypoint":"run"}'),
  ];
  for (const invalidManifest of invalidManifests) {
    assert.throws(() => parseReleaseBundle(bundle([
      { name: "manifest.json", content: invalidManifest },
      { name: "run", content: "x", mode: 0o755 },
    ])), /manifest/);
  }
});

test("enforces compressed-size, expanded-size declarations, file-count, and manifest limits", () => {
  assert.throws(() => parseReleaseBundle(Buffer.alloc(64 * 1024 * 1024 + 1)), /compressed bundle exceeds/);
  assert.throws(() => parseReleaseBundle(bundle([
    { name: "manifest.json", content: manifest() },
    { name: "run", content: "x", mode: 0o755 },
    { name: "huge", content: "", declaredSize: 256 * 1024 * 1024 + 1 },
  ])), /truncated or exceeds the archive/);
  const tooManyFiles: Entry[] = [
    { name: "manifest.json", content: manifest() },
    { name: "run", content: "x", mode: 0o755 },
  ];
  for (let index = 0; index < 10_001; index++) tooManyFiles.push({ name: `f${index}`, content: "" });
  assert.throws(() => parseReleaseBundle(bundle(tooManyFiles)), /10,000 (?:files|total entries)/);
  assert.throws(() => parseReleaseBundle(bundle([
    { name: "manifest.json", content: Buffer.alloc(64 * 1024 + 1, 0x20) },
    { name: "run", content: "x", mode: 0o755 },
  ])), /manifest.json exceeds/);
});
