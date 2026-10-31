import { existsSync, readdirSync, statSync, lstatSync, readFileSync, createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Dependencies } from "../shared/types.js";
import { fail } from "../shared/http.js";
import { reportingSettings } from "./settings.js";
import type { AgentCredentialStore } from "./agent-credentials.js";
export function registerInstall(
  d: Dependencies,
  directory: string,
  agentCredentials?: AgentCredentialStore,
) {
  const version = "0.1.0";
  const basePackages = [
    ['go', 'Go', 'Go 1.26+', `lightmoni-go-sdk_${version}.tar.gz`],
    [
      "typescript",
      "JavaScript / TypeScript / 浏览器",
      "Node.js 20+ / 现代浏览器",
      `lightmoni-sdk-${version}.tgz`,
    ],
    [
      "python",
      "Python",
      "Python 3.9+",
      `lightmoni-python-sdk_${version}.tar.gz`,
    ],
    ['rust', 'Rust', 'Rust 1.85+', `lightmoni-rust-sdk_${version}.tar.gz`],
  ];
  const packages = (base: string) =>
    basePackages.map(([id, language, runtime, file]) => ({
      id,
      language,
      runtime,
      file,
      url: base + "/downloads/sdk/" + file,
      available: existsSync(join(directory, file)),
    }));
  for (const type of ["agent", "sdk"])
    d.router.get(
      "/downloads/" + type + "/:file",
      async (c) => {
        const file = c.params.file;
        if (type === "agent") {
          c.res.setHeader("cache-control", "private, no-store");
          c.res.setHeader("vary", "Authorization");
          const authorization = c.req.headers.authorization;
          if (!authorization?.startsWith("Bearer "))
            fail(401, "下载 Agent 需要主机部署流程签发的接入令牌");
          const bearer = authorization.slice(7).trim();
          if (!agentCredentials?.canDownloadWithEnrollmentToken(bearer))
            fail(401, "invalid host-bound enrollment token");
          if (
            !["install.sh", "uninstall.sh", "SHA256SUMS"].includes(file) &&
            !/^lightmoni-agent_[0-9A-Za-z._-]+_linux_(amd64|arm64)\.tar\.gz$/.test(
              file,
            )
          )
            fail(404, "file not found");
        } else if (
          file !== "SDK_SHA256SUMS" &&
          !basePackages.some((p) => p[3] === file)
        )
          fail(404, "file not found");
        const path = join(directory, file);
        if (!existsSync(path) || !statSync(path).isFile())
          fail(404, "file not found");
        c.res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-disposition": 'attachment; filename="' + file + '"',
          "content-length": statSync(path).size,
        });
        await pipeline(createReadStream(path), c.res, { signal: c.signal });
      },
      { public: true },
    );
  d.router.get("/api/v1/agent-maintenance/uninstaller", (c) => {
    d.auth.requireAdmin(c);
    c.res.setHeader("cache-control", "private, no-store");
    const path = join(directory, "uninstall.sh");
    if (!existsSync(path)) fail(404, "Agent uninstaller is not available in this platform release");
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 262144)
      fail(503, "Agent uninstaller is not available in this platform release");
    const bytes = readFileSync(path);
    c.json({ filename: "lightmoni-agent-uninstall.sh", sha256: createHash("sha256").update(bytes).digest("hex"), script: bytes.toString("utf8") });
  });
  d.router.get("/api/v1/sdk-install", (c) => {
    const settings = reportingSettings(d),
      base = settings.endpoints.find((e: any) => e.scope === "public" && e.id===settings.default_endpoint_id)?.url ?? settings.endpoints.find((e: any) => e.scope === "public")?.url ?? settings.effective_endpoint;
    c.json({
      version,
      endpoint: base,
      endpoints: settings.endpoints,
      default_endpoint_id: settings.default_endpoint_id,
      node_url: base + `/downloads/sdk/lightmoni-sdk-${version}.tgz`,
      packages: packages(base),
      go_url: base + `/downloads/sdk/lightmoni-go-sdk_${version}.tar.gz`,
      checksums_url: base + "/downloads/sdk/SDK_SHA256SUMS",
    });
  });
  d.router.get("/api/v1/agent-install", (c) => {
    const settings = reportingSettings(d),
      base = settings.endpoints.find((e: any) => e.scope === "public" && e.id===settings.default_endpoint_id)?.url ?? settings.endpoints.find((e: any) => e.scope === "public")?.url ?? settings.effective_endpoint,
      bundles = existsSync(directory)
        ? readdirSync(directory)
            .filter((v) => /^lightmoni-agent_.*\.tar\.gz$/.test(v))
            .sort()
        : [];
    c.json({
      version,
      endpoint: base,
      endpoints: settings.endpoints,
      default_endpoint_id: settings.default_endpoint_id,
      release_url: base + "/downloads/agent",
      install_url: base + "/downloads/agent/install.sh",
      bundles,
      requires_key: true,
    });
  });
}
