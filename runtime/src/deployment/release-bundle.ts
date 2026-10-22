import { gunzipSync } from "node:zlib";

const BLOCK_SIZE = 512;
const MAX_COMPRESSED_BYTES = 64 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 256 * 1024 * 1024;
const MAX_FILES = 10_000;
const MAX_ENTRIES = 10_000;
const MAX_MANIFEST_BYTES = 64 * 1024;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SERVICE_ID = /^[a-f0-9]{32}$/i;
const ARCHITECTURES = new Set(["any", "linux-amd64", "linux-arm64"]);

export interface ReleaseBundleManifest {
  schema_version: 1;
  service_id: string;
  version: string;
  architecture: "any" | "linux-amd64" | "linux-arm64";
  source_revision: string;
  entrypoint: "run";
}

export interface ReleaseBundleFile {
  path: string;
  /** Permission bits from the archive, with all special bits rejected. */
  mode: number;
  content: Buffer;
}

export interface ParsedReleaseBundle {
  manifest: ReleaseBundleManifest;
  files: ReleaseBundleFile[];
  directories: string[];
  /** Total decompressed tar bytes, including headers and padding. */
  expandedBytes: number;
}

function invalid(message: string): never {
  throw new Error(`invalid release bundle: ${message}`);
}

function decodeString(field: Buffer, label: string): string {
  const end = field.indexOf(0);
  const actual = end < 0 ? field : field.subarray(0, end);
  if (end >= 0 && field.subarray(end).some((byte) => byte !== 0)) invalid(`${label} has data after NUL`);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(actual);
  } catch {
    return invalid(`${label} is not valid UTF-8`);
  }
}

function parseOctal(field: Buffer, label: string): number {
  // POSIX USTAR numeric fields are octal ASCII. Base-256 and signed encodings
  // are deliberately rejected so a platform-specific interpretation cannot
  // change the path or size that the Agent validates.
  if (field.length && (field[0]! & 0x80) !== 0) invalid(`${label} uses a non-octal encoding`);
  const raw = field.toString("ascii");
  const value = raw.replace(/[\0 ]+$/g, "").replace(/^[ ]+/g, "");
  if (value === "") return 0;
  if (!/^[0-7]+$/.test(value)) invalid(`${label} is not octal`);
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed)) invalid(`${label} is too large`);
  return parsed;
}

function checksum(header: Buffer): number {
  let sum = 0;
  for (let index = 0; index < BLOCK_SIZE; index++) {
    sum += index >= 148 && index < 156 ? 0x20 : header[index]!;
  }
  return sum;
}

function validateHeader(header: Buffer): void {
  if (header.length !== BLOCK_SIZE) invalid("truncated USTAR header");
  if (header.toString("binary", 257, 263) !== "ustar\0" || header.toString("binary", 263, 265) !== "00")
    invalid("archive contains a non-USTAR header");
  const expected = parseOctal(header.subarray(148, 156), "header checksum");
  if (checksum(header) !== expected) invalid("header checksum mismatch");
}

function safeArchivePath(rawName: string, rawPrefix: string, isDirectory: boolean): string {
  if (!rawName) invalid("entry path is empty");
  if (rawName.includes("\\") || rawName.startsWith("/") || /^[A-Za-z]:/.test(rawName))
    invalid("entry path is absolute or uses a platform-specific separator");
  if (rawPrefix && (rawPrefix.includes("\\") || rawPrefix.startsWith("/") || /^[A-Za-z]:/.test(rawPrefix)))
    invalid("entry prefix is absolute or uses a platform-specific separator");

  let path = rawPrefix ? `${rawPrefix}/${rawName}` : rawName;
  if (isDirectory && path.endsWith("/")) path = path.slice(0, -1);
  if (!path || path.endsWith("/")) invalid("entry path is malformed");
  const parts = path.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) invalid("entry path escapes or aliases the archive root");
  if ([...path].some((char) => {
    const code = char.codePointAt(0)!;
    return code < 0x20 || (code >= 0x7f && code <= 0x9f);
  })) invalid("entry path contains control characters");
  if (path.normalize("NFC") !== path) invalid("entry path is not Unicode-normalized");
  return path;
}

function hasDuplicateTopLevelKeys(source: string): boolean {
  // JSON.parse accepts duplicate object keys and silently keeps the last one.
  // The manifest has a flat schema, so inspect its top-level keys before using
  // the parsed object to prevent contradictory signed/validated values.
  const skipWhitespace = (start: number) => {
    let index = start;
    while (/\s/.test(source[index] ?? "")) index++;
    return index;
  };
  const stringEnd = (start: number) => {
    let escaped = false;
    for (let index = start + 1; index < source.length; index++) {
      const char = source[index]!;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') return index + 1;
    }
    return source.length;
  };

  let index = skipWhitespace(0);
  if (source[index] !== "{") return false; // JSON.parse reports the syntax error.
  index++;
  const seen = new Set<string>();
  while (index < source.length) {
    index = skipWhitespace(index);
    if (source[index] === "}") return false;
    if (source[index] !== '"') return false;
    const keyEnd = stringEnd(index);
    let key: string;
    try { key = JSON.parse(source.slice(index, keyEnd)) as string; } catch { return false; }
    if (seen.has(key)) return true;
    seen.add(key);
    index = skipWhitespace(keyEnd);
    if (source[index] !== ":") return false;
    index = skipWhitespace(index + 1);

    let depth = 0;
    let inString = false;
    let escaped = false;
    for (; index < source.length; index++) {
      const char = source[index]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
      } else if (char === '"') inString = true;
      else if (char === "{" || char === "[") depth++;
      else if (char === "}" || char === "]") {
        if (depth === 0) break;
        depth--;
      } else if (char === "," && depth === 0) break;
    }
    if (source[index] === ",") index++;
    else return false;
  }
  return false;
}

function validateManifest(content: Buffer): ReleaseBundleManifest {
  if (content.length > MAX_MANIFEST_BYTES) invalid("manifest.json exceeds 64 KiB");
  let parsed: unknown;
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(content);
    parsed = JSON.parse(source);
  } catch {
    return invalid("manifest.json is not valid UTF-8 JSON");
  }
  if (hasDuplicateTopLevelKeys(source!)) invalid("manifest.json contains duplicate fields");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) invalid("manifest.json must be an object");
  const value = parsed as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  const expected = ["architecture", "entrypoint", "schema_version", "service_id", "source_revision", "version"];
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index]))
    invalid("manifest.json has missing or unknown fields");
  if (value.schema_version !== 1) invalid("manifest schema_version is unsupported");
  if (typeof value.service_id !== "string" || !SERVICE_ID.test(value.service_id)) invalid("manifest service_id is invalid");
  if (typeof value.version !== "string" || !VERSION.test(value.version)) invalid("manifest version is invalid");
  if (typeof value.architecture !== "string" || !ARCHITECTURES.has(value.architecture)) invalid("manifest architecture is invalid");
  if (typeof value.source_revision !== "string" || Buffer.byteLength(value.source_revision, "utf8") > 256)
    invalid("manifest source_revision must be a string of at most 256 bytes");
  if (value.entrypoint !== "run") invalid("manifest entrypoint must be run");
  return value as unknown as ReleaseBundleManifest;
}

function isZeroBlock(block: Buffer): boolean {
  for (const byte of block) if (byte !== 0) return false;
  return true;
}

/**
 * Parse a gzip-compressed POSIX USTAR release bundle without extracting it.
 * Only regular files and directories are accepted. The returned buffers are
 * copied out of the decompressed archive. Callers must still use a safe,
 * private extraction directory and no-follow filesystem operations.
 */
export function parseReleaseBundle(input: Buffer): ParsedReleaseBundle {
  if (!Buffer.isBuffer(input)) invalid("input must be a Buffer");
  if (input.length > MAX_COMPRESSED_BYTES) invalid("compressed bundle exceeds 64 MiB");
  let archive: Buffer;
  try {
    archive = gunzipSync(input, { maxOutputLength: MAX_EXPANDED_BYTES });
  } catch {
    return invalid("gzip stream is invalid or exceeds the 256 MiB expanded limit");
  }
  if (archive.length > MAX_EXPANDED_BYTES) invalid("expanded bundle exceeds 256 MiB");
  if (archive.length < 2 * BLOCK_SIZE || archive.length % BLOCK_SIZE !== 0) invalid("tar stream has an invalid block length");

  const files: ReleaseBundleFile[] = [];
  const directories: string[] = [];
  const entries = new Map<string, "file" | "directory">();
  const pathsWithChildren = new Set<string>();
  let offset = 0;
  let endMarker = false;
  let entryCount = 0;
  while (offset + BLOCK_SIZE <= archive.length) {
    const header = archive.subarray(offset, offset + BLOCK_SIZE);
    if (isZeroBlock(header)) {
      if (offset + 2 * BLOCK_SIZE > archive.length || !isZeroBlock(archive.subarray(offset + BLOCK_SIZE, offset + 2 * BLOCK_SIZE)))
        invalid("tar stream must end with two zero blocks");
      if (!isZeroBlock(archive.subarray(offset + 2 * BLOCK_SIZE))) invalid("non-zero data follows the tar end marker");
      endMarker = true;
      break;
    }
    validateHeader(header);
    entryCount++;
    if (entryCount > MAX_ENTRIES) invalid("archive exceeds 10,000 total entries");
    const name = decodeString(header.subarray(0, 100), "entry name");
    const prefix = decodeString(header.subarray(345, 500), "entry prefix");
    const typeFlag = header[156]!;
    const isFile = typeFlag === 0 || typeFlag === 0x30;
    const isDirectory = typeFlag === 0x35;
    if (!isFile && !isDirectory) invalid("links, devices, sparse files, and USTAR extensions are not allowed");
    const linkName = decodeString(header.subarray(157, 257), "link name");
    if (linkName) invalid("link metadata is not allowed");
    const path = safeArchivePath(name, prefix, isDirectory);
    const mode = parseOctal(header.subarray(100, 108), "mode");
    if ((mode & ~0o777) !== 0) invalid("special permission bits are not allowed");
    const size = parseOctal(header.subarray(124, 136), "entry size");
    if (isDirectory && size !== 0) invalid("directory entries must be empty");
    if (entries.has(path)) invalid("archive contains a duplicate path");
    const kind = isFile ? "file" : "directory";
    for (let slash = path.indexOf("/"); slash >= 0; slash = path.indexOf("/", slash + 1)) {
      const parent = path.slice(0, slash);
      if (entries.get(parent) === "file") invalid("a file is used as a parent directory");
      pathsWithChildren.add(parent);
    }
    if (kind === "file" && pathsWithChildren.has(path))
      invalid("a file conflicts with an existing directory path");
    entries.set(path, kind);
    if (isDirectory) directories.push(path);

    const dataOffset = offset + BLOCK_SIZE;
    const paddedSize = Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
    if (!Number.isSafeInteger(paddedSize) || dataOffset + paddedSize > archive.length)
      invalid("entry data is truncated or exceeds the archive");
    if (paddedSize > size && !isZeroBlock(archive.subarray(dataOffset + size, dataOffset + paddedSize)))
      invalid("entry padding contains non-zero data");
    if (kind === "file") {
      if (files.length >= MAX_FILES) invalid("archive exceeds 10,000 files");
      const content = Buffer.from(archive.subarray(dataOffset, dataOffset + size));
      if (path === "manifest.json" && content.length > MAX_MANIFEST_BYTES) invalid("manifest.json exceeds 64 KiB");
      files.push({ path, mode, content });
    }
    offset = dataOffset + paddedSize;
  }
  if (!endMarker) invalid("tar end marker is missing");

  const manifestEntry = files.find((file) => file.path === "manifest.json");
  const runEntry = files.find((file) => file.path === "run");
  if (!manifestEntry) invalid("archive root is missing regular manifest.json");
  if (!runEntry) invalid("archive root is missing regular run file");
  if ((runEntry.mode & 0o111) === 0) invalid("run file must have an execute bit");
  const manifest = validateManifest(manifestEntry.content);
  return { manifest, files, directories, expandedBytes: archive.length };
}
