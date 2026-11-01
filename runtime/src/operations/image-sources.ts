import { OperationRejectedError } from "./errors.js";
import {
  dockerPlatform,
  localDockerImage,
  prepareCachedImages,
} from "./image-cache.js";
import type { OperationExecutionContext } from "./types.js";
import { installCause } from "./install-progress.js";

export interface ImageSourceRule {
  source: string;
  target: string;
  allow_upstream: boolean;
}
export interface ImageSourcePolicy {
  version: 1;
  revision: number;
  rules: ImageSourceRule[];
}
const reject = (code = "INVALID_IMAGE_SOURCES"): never => {
  throw new OperationRejectedError(code);
};
const repository =
  /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*$/;
const hub = (host: string) =>
  ["docker.io", "index.docker.io", "registry-1.docker.io"].includes(host)
    ? "docker.io"
    : host;
function registry(raw: unknown): string {
  if (
    typeof raw !== "string" ||
    raw.length > 253 ||
    !/^(?:localhost|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::[0-9]{1,5})?$/.test(
      raw,
    )
  )
    return reject();
  let u: URL;
  try {
    u = new URL("https://" + raw);
  } catch {
    return reject();
  }
  if (u.port && (+u.port < 1 || +u.port > 65535)) return reject();
  return hub(u.host);
}
export function imageSourceRules(raw: unknown): ImageSourceRule[] {
  if (!Array.isArray(raw) || raw.length > 20) return reject();
  const seen = new Set<string>();
  return raw.map((r) => {
    if (
      !r ||
      typeof r !== "object" ||
      Object.keys(r).some(
        (k) => !["source", "target", "allow_upstream"].includes(k),
      ) ||
      typeof r.allow_upstream !== "boolean"
    )
      return reject();
    const source = registry(r.source);
    if (
      typeof r.target !== "string" ||
      r.target.length > 512 ||
      !/^https:\/\//.test(r.target) ||
      /[\s\\?#]/.test(r.target)
    )
      return reject();
    let u: URL;
    try {
      u = new URL(r.target);
    } catch {
      return reject();
    }
    const path = u.pathname.replace(/\/$/, "").slice(1);
    if (
      u.username ||
      u.password ||
      (path && !repository.test(path)) ||
      /(?:^|\/)\.{1,2}(?:\/|$)/.test(r.target.slice(8))
    )
      return reject();
    registry(u.host);
    if (hub(u.host) === source || seen.has(source)) return reject();
    seen.add(source);
    return {
      source,
      target: u.origin + (path ? "/" + path : ""),
      allow_upstream: r.allow_upstream,
    };
  });
}
export function imageSourcePolicy(raw: any): ImageSourcePolicy {
  if (
    !raw ||
    raw.version !== 1 ||
    !Number.isSafeInteger(raw.revision) ||
    raw.revision < 0
  )
    return reject();
  return {
    version: 1,
    revision: raw.revision,
    rules: imageSourceRules(raw.rules),
  };
}
/** Parse once, match the exact registry, and preserve tag/digest. Never perform string replacement. */
export function imageSourceReference(image: string, rules: ImageSourceRule[]) {
  if (typeof image !== "string" || image.length > 512 || /[\s\\?#]/.test(image))
    return reject("INVALID_IMAGE_REFERENCE");
  if (/^sha256:[a-f0-9]{64}$/.test(image)) return;
  let name = image,
    suffix = ":latest";
  const at = name.indexOf("@");
  if (at >= 0) {
    suffix = name.slice(at);
    name = name.slice(0, at);
    if (!/^@sha256:[a-f0-9]{64}$/.test(suffix))
      return reject("INVALID_IMAGE_REFERENCE");
    // Docker permits name:tag@digest; the digest remains authoritative.
    if (name.lastIndexOf(":") > name.lastIndexOf("/"))
      name = name.slice(0, name.lastIndexOf(":"));
  } else if (name.lastIndexOf(":") > name.lastIndexOf("/")) {
    suffix = name.slice(name.lastIndexOf(":"));
    name = name.slice(0, name.lastIndexOf(":"));
    if (!/^:[\w][\w.-]{0,127}$/.test(suffix))
      return reject("INVALID_IMAGE_REFERENCE");
  }
  const first = name.split("/")[0],
    explicit =
      name.includes("/") &&
      (first.includes(".") || first.includes(":") || first === "localhost");
  const source = explicit ? registry(first) : "docker.io";
  let repo = explicit ? name.slice(first.length + 1) : name;
  if (!repository.test(repo)) return reject("INVALID_IMAGE_REFERENCE");
  if (source === "docker.io" && !repo.includes("/")) repo = "library/" + repo;
  const rule = rules.find((r) => r.source === source);
  return rule
    ? {
        rule,
        mapped: rule.target.slice("https://".length) + "/" + repo + suffix,
      }
    : undefined;
}

/** Cache and proxy preparation share the exact effective image used by preflight and startup. */
export async function preparePlatformImages(
  manifest: any,
  config: any,
  root: string,
  context: OperationExecutionContext,
) {
  const policy = config.image_sources
    ? imageSourcePolicy(config.image_sources)
    : undefined;
  if (!policy)
    return config.image_cache
      ? prepareCachedImages(manifest, config.image_cache, root, context)
      : [];
  const platform = await dockerPlatform(context),
    results: any[] = [];
  await context.progress?.("preparing_images");
  for (const image of new Set<string>(
    Object.values<any>(manifest.services).map((s) => s.image),
  )) {
    const mapped = imageSourceReference(image, policy.rules);
    let result: any;
    const one = { services: { image: { image } } };
    if (config.image_cache) {
      const cache = await prepareCachedImages(
        one,
        config.image_cache,
        root,
        context,
      );
      result = cache.find((r) => r.image_id);
      if (!result) results.push(...cache.filter((r) => !r.image_id));
    } else if (mapped)
      result = await localDockerImage(image, platform, context);
    if (!result && mapped) {
      try {
        // A previously verified proxy reference can be reused; source credentials are never copied.
        result = await localDockerImage(mapped.mapped, platform, context);
        if (!result) {
          await context.command("docker", ["image", "pull", mapped.mapped], {
            timeoutMs: 300000,
            signal: context.signal,
          });
          result = await localDockerImage(mapped.mapped, platform, context);
        }
        if (!result) reject("IMAGE_PROXY_NOT_VERIFIED");
        result = { ...result, image, source: "registry-proxy" };
      } catch (error) {
        context.signal.throwIfAborted();
        if (!mapped.rule.allow_upstream)
          throw Object.assign(
            new OperationRejectedError("IMAGE_PROXY_FAILED"),
            { diagnosticCode: installCause(error) || "image_proxy_failed" },
          );
        results.push({
          image,
          source: "upstream-fallback",
          code: installCause(error) || "image_proxy_failed",
        });
      }
    }
    if (result) {
      results.push(result);
      for (const service of Object.values<any>(manifest.services))
        if (service.image === image) {
          service.image = result.image_id;
          service.pull_policy = "never";
        }
    }
  }
  return results;
}
