import { existsSync, readdirSync, statSync, createReadStream } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Dependencies } from "../shared/types.js";
import { fail } from "../shared/http.js";
import { reportingSettings } from "./settings.js";
export function registerInstall(d: Dependencies, directory: string) {
  const version = "0.1.0";
  const basePackages = [
    [
      "typescript",
      "JavaScript / TypeScript / 浏览器",
      "Node.js 20+ / 现代浏览器",
      `lightmoni-sdk-${version}.tgz`,
    ],
    ["go", "Go", "Go 1.26+", `lightmoni-go-sdk_${version}.tar.gz`],
    [
      "python",
      "Python",
      "Python 3.9+",
      `lightmoni-python-sdk_${version}.tar.gz`,
    ],
    [
      "java",
      "Java / Kotlin JVM",
      "JDK 17+",
      `lightmoni-java-sdk_${version}.tar.gz`,
    ],
    [
      "dotnet",
      "C# / .NET",
      ".NET 8+",
      `lightmoni-dotnet-sdk_${version}.tar.gz`,
    ],
    ["php", "PHP", "64 位 PHP 8.1+", `lightmoni-php-sdk_${version}.tar.gz`],
    ["ruby", "Ruby", "Ruby 2.7+", `lightmoni-ruby-sdk_${version}.tar.gz`],
    ["rust", "Rust", "Rust 1.85+", `lightmoni-rust-sdk_${version}.tar.gz`],
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
          if (!c.req.headers.authorization?.startsWith("Bearer "))
            fail(401, "下载 Agent 需要有效的上报 Key");
          d.auth.validateKey(c);
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
  d.router.get("/api/v1/sdk-install", (c) => {
    const settings = reportingSettings(d),
      base = settings.effective_endpoint;
    c.json({
      version,
      endpoint: base,
      endpoints: settings.endpoints,
      default_endpoint_id: settings.default_endpoint_id,
      node_url: base + `/downloads/sdk/lightmoni-sdk-${version}.tgz`,
      go_url: base + `/downloads/sdk/lightmoni-go-sdk_${version}.tar.gz`,
      packages: packages(base),
      checksums_url: base + "/downloads/sdk/SDK_SHA256SUMS",
    });
  });
  d.router.get("/api/v1/agent-install", (c) => {
    const settings = reportingSettings(d),
      base = settings.effective_endpoint,
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
