import { createHash, randomBytes } from "node:crypto";
import { readdir, readFile, lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export interface InstrumentationFinding {
  file: string;
  kind: "request_boundary" | "error_boundary" | "sdk_import" | "sdk_call" | "deployment_entry";
  confidence: number;
  line?: number;
  summary: string;
}

export interface InstrumentationScan {
  plan_id: string;
  workspace: string;
  base_revision: string;
  state: "scanned";
  languages: string[];
  frameworks: string[];
  package_managers: string[];
  sdk: { found: boolean; packages: string[]; versions: string[]; mode: "direct" | "agent" | "unknown" };
  candidates: InstrumentationFinding[];
  warnings: string[];
  files_scanned: number;
}

const SKIP = new Set([".git", "node_modules", "dist", "build", ".local-dev", ".lightmoni", ".ssh", "vendor", "target"]);
const SOURCE = /\.(?:ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|swift)$/i;
const MAX_FILES = 5000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;

async function safeWorkspace(root: string, workspace: string): Promise<string> {
  // Check the canonical paths, not only their lexical spelling. Otherwise a
  // workspace symlink inside the configured root could escape to an arbitrary
  // directory while still passing the relative-path check.
  let resolvedRoot: string, resolved: string;
  try {
    resolvedRoot = await realpath(resolve(root));
    resolved = await realpath(resolve(resolvedRoot, workspace || "."));
  } catch {
    // Do not return host filesystem paths in a model-visible tool error.
    throw Error("workspace is unavailable");
  }
  const rel = relative(resolvedRoot, resolved);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw Error("workspace is outside the configured code root");
  return resolved;
}

function language(path: string): string | undefined {
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
  return ({ ".ts": "typescript", ".tsx": "typescript", ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript", ".py": "python", ".go": "go", ".rs": "rust", ".rb": "ruby", ".java": "java", ".kt": "kotlin", ".swift": "swift" } as Record<string, string>)[ext];
}

function addFinding(findings: InstrumentationFinding[], value: InstrumentationFinding) {
  if (findings.length < 100) findings.push(value);
}

/**
 * Read-only SDK onboarding scan. It never imports a project, executes package
 * scripts, follows symlinks, or writes a patch. A later proposal can hand the
 * result to the existing isolated code_task flow for an explicit diff.
 */
export class InstrumentationService {
  constructor(readonly root: string) {}

  async scan(workspace = ".", signal?: AbortSignal): Promise<InstrumentationScan> {
    const absolute = await safeWorkspace(this.root, workspace), files: string[] = [];
    let total = 0;
    const walk = async (dir: string, prefix: string): Promise<void> => {
      signal?.throwIfAborted();
      const entries = await readdir(dir, { withFileTypes: true });
      // Use code-unit ordering rather than localeCompare so the digest is
      // deterministic across hosts with different locale settings.
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const entry of entries) {
        signal?.throwIfAborted();
        if (SKIP.has(entry.name) || entry.name.startsWith(".")) continue;
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        const path = resolve(dir, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (files.length < MAX_FILES) await walk(path, rel);
          continue;
        }
        if (SOURCE.test(entry.name) || ["package.json", "pyproject.toml", "requirements.txt", "go.mod", "Cargo.toml", "pom.xml", "build.gradle", "docker-compose.yml", "compose.yaml"].includes(entry.name)) {
          files.push(rel);
          try { total += (await lstat(path)).size; } catch { /* file may disappear during a scan */ }
        }
        if (files.length >= MAX_FILES || total >= MAX_TOTAL_BYTES) return;
      }
    };
    await walk(absolute, "");
    // A stable file order makes base_revision suitable for optimistic
    // concurrency checks across repeated scans of the same workspace.
    files.sort();
    const languages = new Set<string>(), frameworks = new Set<string>(), packageManagers = new Set<string>(), packages = new Set<string>(), versions = new Set<string>(), candidates: InstrumentationFinding[] = [];
    const digest = createHash("sha256");
    let sawDirectSDK = false, sawAgentSDK = false;
    for (const rel of files) {
      signal?.throwIfAborted();
      const path = resolve(absolute, rel);
      let source: string;
      try {
        const data = await readFile(path);
        if (data.length > MAX_FILE_BYTES || data.includes(0)) continue;
        source = data.toString("utf8");
      } catch { continue; }
      digest.update(rel).update("\0").update(source).update("\0");
      const lang = language(rel);
      if (lang) languages.add(lang);
      if (rel === "package.json") {
        packageManagers.add("npm");
        try {
          const json = JSON.parse(source);
          for (const section of [json.dependencies, json.devDependencies]) for (const [name, version] of Object.entries(section ?? {})) {
            if (/lightmoni/i.test(name)) { packages.add(name); if (typeof version === "string") versions.add(version); }
            if (/express|fastify|nestjs|next|koa|hono/i.test(name)) frameworks.add(name);
          }
        } catch { /* source-level detection below is still useful */ }
      }
      if (rel === "pyproject.toml" || rel === "requirements.txt") packageManagers.add("pip");
      if (rel === "go.mod") packageManagers.add("go");
      if (rel === "Cargo.toml") packageManagers.add("cargo");
      if (rel === "pom.xml" || rel === "build.gradle") packageManagers.add("jvm");
      if (/express|fastify|nestjs|koa|next\//i.test(source)) frameworks.add("node-http");
      if (/fastapi|flask|django|starlette/i.test(source)) frameworks.add("python-http");
      if (/net\/http|gin-gonic|echo\./i.test(source)) frameworks.add("go-http");
      if (/axum|actix-web|rocket::/i.test(source)) frameworks.add("rust-http");
      if (/@lightmoni\/sdk|lightmoni-sdk|from\s+["']lightmoni["']|lightmoni\.record/i.test(source)) {
        packages.add("lightmoni");
        // Do not treat an arbitrary comment/variable containing "agent" as a
        // transport selection. Only explicit mode/endpoint settings count.
        const agentMode = /LIGHTMONI_MODE\s*=\s*["']agent["']|LIGHTMONI_(?:AGENT_)?ENDPOINT\s*=\s*["'](?:https?:\/\/)?(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d{2,5})?|(?:endpoint|url)\s*[:=]\s*["']https?:\/\/(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d{2,5})?/i.test(source);
        if (agentMode) sawAgentSDK = true;
        else sawDirectSDK = true;
        const line = source.split(/\r?\n/).findIndex((value) => /lightmoni/i.test(value));
        addFinding(candidates, { file: rel, kind: "sdk_import", confidence: 0.98, line: line >= 0 ? line + 1 : undefined, summary: "已发现 LightMoni SDK 引用" });
      }
      const lines = source.split(/\r?\n/);
      lines.forEach((line, index) => {
        if (/app\.(get|post|put|patch|delete|use)|router\.(get|post|put|patch)|@(Get|Post|Put|Patch)|FastAPI\(|http\.HandleFunc|def\s+(get|post)|async\s+fn\s+/i.test(line)) addFinding(candidates, { file: rel, kind: "request_boundary", confidence: 0.82, line: index + 1, summary: "疑似请求入口，可在此加入服务级打点" });
        if (/catch\s*\(|except\s+|recover\(\)|Result<.*Error|@ExceptionHandler/i.test(line)) addFinding(candidates, { file: rel, kind: "error_boundary", confidence: 0.76, line: index + 1, summary: "疑似错误边界，可补充错误计数" });
      });
      if (/systemctl|docker compose|docker-compose|uvicorn|gunicorn|node\s+|npm\s+(?:run|start)|cargo\s+run/i.test(source)) addFinding(candidates, { file: rel, kind: "deployment_entry", confidence: 0.68, summary: "发现服务启动或部署入口，部署时应由适配器接管" });
    }
    const revision = digest.digest("hex");
    const sdkMode: "direct" | "agent" | "unknown" =
      sawAgentSDK === sawDirectSDK ? "unknown" : sawAgentSDK ? "agent" : "direct";
    return {
      plan_id: `ip_${randomBytes(12).toString("hex")}`,
      workspace,
      base_revision: revision,
      state: "scanned",
      languages: [...languages].sort(), frameworks: [...frameworks].sort(), package_managers: [...packageManagers].sort(),
      sdk: { found: packages.size > 0, packages: [...packages].sort(), versions: [...versions].sort(), mode: sdkMode },
      candidates,
      warnings: [
        ...(files.length >= MAX_FILES ? ["文件数量达到扫描上限，结果可能不完整"] : []),
        ...(total >= MAX_TOTAL_BYTES ? ["扫描字节数达到上限，结果可能不完整"] : []),
        ...(sawAgentSDK && sawDirectSDK ? ["同时发现直连和 Agent SDK 配置，无法自动确定唯一上报模式"] : []),
        ...(packages.size === 0 ? ["未发现 LightMoni SDK；请确认依赖名称或手动选择插桩位置"] : []),
      ],
      files_scanned: files.length,
    };
  }
}
