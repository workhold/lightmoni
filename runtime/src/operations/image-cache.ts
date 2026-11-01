import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  statfs,
  stat,
} from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import type { OperationExecutionContext } from "./types.js";
import { OperationRejectedError } from "./errors.js";
import { privateRegistryAddress } from "./registry-address.js";

const MAX_DOWNLOAD = 2 * 1024 ** 3,
  MAX_EXPANDED = 4 * 1024 ** 3,
  MAX_JSON = 4 * 1024 ** 2;
const reject = (code: string): never => {
  throw new OperationRejectedError(code);
};
const digest = (value: Buffer) =>
  "sha256:" + createHash("sha256").update(value).digest("hex");
const sha = (s: any): string =>
  typeof s === "string" && /^sha256:[a-f0-9]{64}$/.test(s)
    ? s
    : reject("CACHE_UNSUPPORTED_DIGEST");
function endpoint(raw: any): string {
  if (typeof raw !== "string") return reject("CACHE_INVALID_ENDPOINT");
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return reject("CACHE_INVALID_ENDPOINT");
  }
  if (
    u.protocol !== "http:" ||
    u.username ||
    u.password ||
    u.pathname !== "/" ||
    u.search ||
    u.hash ||
    !u.port
  )
    return reject("CACHE_INVALID_ENDPOINT");
  privateRegistryAddress(u.hostname.replace(/^\[|\]$/g, ""));
  return u.origin;
}
export function cachePolicy(raw: any) {
  if (!raw || raw.version !== 1 || typeof raw.allow_upstream !== "boolean")
    return reject("CACHE_INVALID_POLICY");
  if (
    raw.origin_mode !== undefined &&
    !["direct", "cache"].includes(raw.origin_mode)
  )
    return reject("CACHE_INVALID_POLICY");
  if (
    raw.origin_host !== undefined &&
    (typeof raw.origin_host !== "string" ||
      !/^(?:[A-Za-z0-9.-]+(?::\d+)?)?$/.test(raw.origin_host))
  )
    return reject("CACHE_INVALID_ORIGIN");
  return {
    version: 1,
    allow_upstream: raw.allow_upstream,
    origin_host: raw.origin_host ?? "",
    origin_mode: raw.origin_mode ?? "cache",
    ...(raw.hub_endpoint ? { hub_endpoint: endpoint(raw.hub_endpoint) } : {}),
    ...(raw.origin_endpoint
      ? { origin_endpoint: endpoint(raw.origin_endpoint) }
      : {}),
  };
}
export function cacheReference(
  image: string,
  raw: any,
): { endpoint: string; repository: string; reference: string } | undefined {
  const policy = cachePolicy(raw);
  if (typeof image !== "string" || image.length > 512 || /[\s\\?#]/.test(image))
    return reject("CACHE_INVALID_IMAGE");
  let name = image,
    reference = "latest";
  if (name.includes("@")) {
    const parts = name.split("@");
    if (parts.length !== 2) return reject("CACHE_INVALID_IMAGE");
    name = parts[0];
    reference = sha(parts[1]);
  } else {
    const colon = name.lastIndexOf(":");
    if (colon > name.lastIndexOf("/")) {
      reference = name.slice(colon + 1);
      name = name.slice(0, colon);
      if (!/^[\w][\w.-]{0,127}$/.test(reference))
        return reject("CACHE_INVALID_IMAGE");
    }
  }
  const first = name.split("/")[0];
  let host = "docker.io",
    repository = name;
  if (
    name.includes("/") &&
    (first.includes(".") || first.includes(":") || first === "localhost")
  ) {
    host = first.toLowerCase();
    repository = name.slice(first.length + 1);
  }
  if (
    !/^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/.test(
      repository,
    )
  )
    return reject("CACHE_INVALID_IMAGE");
  if (["docker.io", "index.docker.io", "registry-1.docker.io"].includes(host)) {
    if (!repository.includes("/")) repository = "library/" + repository;
    return policy.hub_endpoint
      ? { endpoint: policy.hub_endpoint, repository, reference }
      : undefined;
  }
  if (
    policy.origin_host &&
    (host === policy.origin_host || host === policy.origin_host + ":443") &&
    policy.origin_endpoint
  )
    return { endpoint: policy.origin_endpoint, repository, reference };
}
function meter(max: number, expected?: string) {
  let bytes = 0;
  const hash = createHash("sha256");
  const stream = new Transform({
    transform(chunk, _, done) {
      bytes += chunk.length;
      if (bytes > max)
        return done(new OperationRejectedError("CACHE_BYTE_LIMIT"));
      hash.update(chunk);
      done(null, chunk);
    },
  });
  return {
    stream,
    finish() {
      const actual = "sha256:" + hash.digest("hex");
      if (expected && actual !== sha(expected)) reject("CACHE_DIGEST_MISMATCH");
      return { bytes, digest: actual };
    },
  };
}
function tarHeader(name: string, size: number): Buffer {
  const b = Buffer.alloc(512),
    put = (s: string, offset: number, length: number) =>
      b.write(s, offset, length, "ascii");
  put(name, 0, 100);
  put("0000600\0", 100, 8);
  put("0000000\0", 108, 8);
  put("0000000\0", 116, 8);
  put(size.toString(8).padStart(11, "0") + "\0", 124, 12);
  put("00000000000\0", 136, 12);
  b.fill(32, 148, 156);
  put("0", 156, 1);
  put("ustar\0", 257, 6);
  put("00", 263, 2);
  const sum = b.reduce((a, n) => a + n, 0);
  put(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8);
  return b;
}
async function archive(
  path: string,
  entries: { name: string; file: string }[],
  signal: AbortSignal,
) {
  // Generated names only; no remote tar extraction or remote paths.
  async function* chunks() {
    for (const e of entries) {
      signal.throwIfAborted();
      const size = (await stat(e.file)).size;
      yield tarHeader(e.name, size);
      for await (const chunk of createReadStream(e.file)) yield chunk;
      const pad = (512 - (size % 512)) % 512;
      if (pad) yield Buffer.alloc(pad);
    }
    yield Buffer.alloc(1024);
  }
  await pipeline(
    Readable.from(chunks()),
    createWriteStream(path, { mode: 0o600 }),
    { signal },
  );
}
/** Downloads through a registered private endpoint, verifies every content address, then imports into Docker.
 * No daemon configuration, ambient credentials, redirects or registry-selected URLs are used.
 */
export async function importCachedImage(
  image: string,
  raw: any,
  root: string,
  context: OperationExecutionContext,
  fetcher: typeof fetch = fetch,
) {
  const ref = cacheReference(image, raw);
  if (!ref) return undefined;
  const tmp = await mkdtemp(join(root, "image-cache-")),
    signal = AbortSignal.any([context.signal, AbortSignal.timeout(300000)]);
  let downloaded = 0,
    expanded = 0;
  const get = async (path: string, expected?: string, max = MAX_JSON) => {
    signal.throwIfAborted();
    const r = await fetcher(
      ref.endpoint + "/v2/" + ref.repository + "/" + path,
      {
        redirect: "error",
        signal,
        headers: {
          Accept:
            "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json",
        },
      },
    );
    if (r.status !== 200 || !r.body) reject("CACHE_FETCH_FAILED");
    const file = join(tmp, "blob-" + Math.random().toString(16).slice(2)),
      count = meter(Math.min(max, MAX_DOWNLOAD - downloaded), expected);
    await pipeline(
      Readable.fromWeb(r.body as any),
      count.stream,
      createWriteStream(file, { mode: 0o600 }),
      { signal },
    );
    const result = count.finish();
    downloaded += result.bytes;
    const header = r.headers.get("docker-content-digest");
    if (header && sha(header) !== result.digest)
      reject("CACHE_DIGEST_MISMATCH");
    return { ...result, file };
  };
  const json = async (path: string, expected?: string) => {
    const result = await get(path, expected);
    let value: any;
    try {
      value = JSON.parse(await readFile(result.file, "utf8"));
    } catch {
      return reject("CACHE_INVALID_MANIFEST");
    }
    return { ...result, value };
  };
  try {
    const disk = await statfs(tmp);
    if (Number(disk.bavail) * Number(disk.bsize) < 512 * 1024 ** 2)
      reject("CACHE_DISK_SPACE_REQUIRED");
    const platform = await context.command(
      "docker",
      ["info", "--format", "{{.OSType}}/{{.Architecture}}"],
      { timeoutMs: 15000, signal },
    );
    const [os, rawArch] = platform.stdout.trim().split("/"),
      arch =
        rawArch === "aarch64"
          ? "arm64"
          : rawArch === "x86_64"
            ? "amd64"
            : rawArch;
    let manifest = await json(
      "manifests/" + ref.reference,
      ref.reference.startsWith("sha256:") ? ref.reference : undefined,
    );
    if (Array.isArray(manifest.value.manifests)) {
      const descriptor = manifest.value.manifests.find(
        (d: any) =>
          d.platform?.os === os &&
          d.platform?.architecture === arch &&
          (!d.platform?.variant || d.platform.variant === "v8"),
      );
      if (!descriptor) reject("CACHE_PLATFORM_NOT_FOUND");
      manifest = await json(
        "manifests/" + sha(descriptor.digest),
        descriptor.digest,
      );
    }
    const m = manifest.value;
    if (
      m.schemaVersion !== 2 ||
      !m.config ||
      !Array.isArray(m.layers) ||
      m.layers.length > 128
    )
      reject("CACHE_UNSUPPORTED_MANIFEST");
    const config = await json("blobs/" + sha(m.config.digest), m.config.digest);
    if (
      config.value.os !== os ||
      config.value.architecture !== arch ||
      !Array.isArray(config.value.rootfs?.diff_ids) ||
      config.value.rootfs.diff_ids.length !== m.layers.length
    )
      reject("CACHE_PLATFORM_MISMATCH");
    const entries = [{ name: "config.json", file: config.file }],
      layers = [];
    for (const [i, layer] of m.layers.entries()) {
      if (
        !Number.isSafeInteger(layer.size) ||
        layer.size < 0 ||
        layer.size > MAX_DOWNLOAD - downloaded
      )
        reject("CACHE_BYTE_LIMIT");
      if (
        ![
          "application/vnd.oci.image.layer.v1.tar",
          "application/vnd.oci.image.layer.v1.tar+gzip",
          "application/vnd.docker.image.rootfs.diff.tar.gzip",
        ].includes(layer.mediaType)
      )
        reject("CACHE_UNSUPPORTED_LAYER");
      const free = await statfs(tmp);
      if (
        Number(free.bavail) * Number(free.bsize) <
        Math.max(128 * 1024 ** 2, layer.size * 3)
      )
        reject("CACHE_DISK_SPACE_REQUIRED");
      const blob = await get(
        "blobs/" + sha(layer.digest),
        layer.digest,
        layer.size,
      );
      if (blob.bytes !== layer.size) reject("CACHE_LAYER_SIZE_MISMATCH");
      const afterDownload = await statfs(tmp);
      const expansionBudget = Math.max(
        0,
        Number(afterDownload.bavail) * Number(afterDownload.bsize) -
          128 * 1024 ** 2,
      );
      const target = join(tmp, "layer-" + i),
        count = meter(
          Math.min(MAX_EXPANDED - expanded, expansionBudget),
          sha(config.value.rootfs.diff_ids[i]),
        );
      if (layer.mediaType.endsWith("gzip"))
        await pipeline(
          createReadStream(blob.file),
          createGunzip(),
          count.stream,
          createWriteStream(target, { mode: 0o600 }),
          { signal },
        );
      else
        await pipeline(
          createReadStream(blob.file),
          count.stream,
          createWriteStream(target, { mode: 0o600 }),
          { signal },
        );
      expanded += count.finish().bytes;
      await rm(blob.file);
      const name = "layer-" + i + "/layer.tar";
      layers.push(name);
      entries.push({ name, file: target });
    }
    const importedTag = "lightmoni-cache/verified:c-" + config.digest.slice(7);
    const metadata = join(tmp, "manifest.json");
    await writeFile(
      metadata,
      JSON.stringify([
        { Config: "config.json", RepoTags: [importedTag], Layers: layers },
      ]),
      { mode: 0o600 },
    );
    entries.push({ name: "manifest.json", file: metadata });
    const remaining = await statfs(tmp);
    if (
      Number(remaining.bavail) * Number(remaining.bsize) <
      expanded + 64 * 1024 ** 2
    )
      reject("CACHE_DISK_SPACE_REQUIRED");
    const tar = join(tmp, "image.tar");
    await archive(tar, entries, signal);
    await context.command("docker", ["image", "load", "--input", tar], {
      timeoutMs: 300000,
      signal,
    });
    const inspected = await context.command(
      "docker",
      ["image", "inspect", "--format", "{{json .}}", importedTag],
      { timeoutMs: 15000, signal },
    );
    let loaded: any;
    try {
      loaded = JSON.parse(inspected.stdout);
    } catch {
      reject("CACHE_IMPORT_NOT_VERIFIED");
    }
    // Docker's classic store returns the config ID; its containerd store returns an image descriptor ID.
    // The generated tag is loaded only from our verified archive, and the resulting platform/rootfs must match.
    if (
      !/^sha256:[a-f0-9]{64}$/.test(loaded.Id) ||
      loaded.Os !== os ||
      loaded.Architecture !== arch ||
      JSON.stringify(loaded.RootFS?.Layers ?? []) !==
        JSON.stringify(config.value.rootfs.diff_ids)
    )
      reject("CACHE_IMPORT_NOT_VERIFIED");
    return {
      image,
      image_id: loaded.Id,
      config_digest: config.digest,
      manifest_digest: manifest.digest,
      source:
        ref.endpoint === raw.origin_endpoint && raw.origin_mode === "direct"
          ? "cluster-registry"
          : "cluster-cache",
      downloaded_bytes: downloaded,
    };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
export async function prepareCachedImages(
  manifest: any,
  policy: any,
  root: string,
  context: OperationExecutionContext,
) {
  cachePolicy(policy);
  const sources: any[] = [];
  for (const image of new Set<string>(
    Object.values<any>(manifest.services).map((s) => s.image),
  )) {
    let result;
    try {
      result = await importCachedImage(image, policy, root, context);
    } catch (error) {
      context.signal.throwIfAborted();
      if (!policy.allow_upstream) throw error;
      sources.push({
        image,
        source: "upstream-fallback",
        code:
          error instanceof OperationRejectedError
            ? error.message
            : "CACHE_UNAVAILABLE",
      });
      continue;
    }
    if (!result) continue;
    sources.push(result);
    for (const service of Object.values<any>(manifest.services))
      if (service.image === image) {
        service.image = result.image_id;
        service.pull_policy = "never";
      }
  }
  return sources;
}
