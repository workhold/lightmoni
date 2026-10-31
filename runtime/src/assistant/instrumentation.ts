import { createHash, randomBytes } from "node:crypto";
import { readdir, readFile, lstat, realpath, writeFile, rename, rm, chmod } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { createTwoFilesPatch } from "diff";

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
  sdk: { found: boolean; packages: string[]; versions: string[]; mode: "direct" | "unknown"; legacy_agent_config?: boolean };
  candidates: InstrumentationFinding[];
  warnings: string[];
  files_scanned: number;
}

export interface InstrumentationProposalInput {
  workspace: string;
  intent: string;
  base_revision?: string;
  service?: string;
  env?: string;
  mode?: "direct";
  table?: string;
  metric?: string;
}

export interface InstrumentationOperation {
  /** A 1-based insertion point. The source file is never changed by propose. */
  op: "insert";
  line: number;
  content: string;
}

export interface InstrumentationPlanFile {
  path: string;
  summary: string;
  patch: string;
  operations: InstrumentationOperation[];
  risks: string[];
  validation_steps: string[];
}

export interface InstrumentationPlan {
  plan_id: string;
  workspace: string;
  base_revision: string;
  state: "awaiting_approval";
  intent: string;
  files: InstrumentationPlanFile[];
  manual_steps: string[];
  warnings: string[];
  validation_steps: string[];
}

export interface InstrumentationApplyInput {
  base_revision: string;
  approval: "apply";
  idempotency_key?: string;
}

export interface InstrumentationApplyResult {
  plan_id: string;
  state: "applied";
  result_revision: string;
  changed_files: string[];
  applied_at: string;
  idempotent?: boolean;
}

interface StoredInstrumentationPlan {
  plan: InstrumentationPlan;
  before: Record<string, string>;
  applied: InstrumentationApplyResult | null;
  idempotency_key?: string;
}

export interface InstrumentationStore {
  get<T>(key: string): T | undefined;
  put<T>(key: string, value: T): void;
}

export interface InstrumentationServiceOptions {
  store?: InstrumentationStore;
  now?: () => Date;
}

const SKIP = new Set([".git", "node_modules", "dist", "build", ".local-dev", ".lightmoni", ".ssh", "vendor", "target"]);
const SOURCE = /\.(?:ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|swift)$/i;
const MAX_FILES = 5000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_PLAN_BYTES = 8 * 1024 * 1024;

const VALID_IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const VALID_TABLE = /^[a-z][a-z0-9_]{0,47}$/;
// SDK metric names accept dots and namespaces; keep the source literal bounded
// while excluding whitespace/control characters and punctuation with shell
// semantics.
const VALID_METRIC = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;

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

function validateProposalValue(value: string | undefined, name: string, pattern: RegExp): string | undefined {
  if (value === undefined) return undefined;
  if (!pattern.test(value)) throw Error(`invalid ${name}`);
  return value;
}

function codeLanguage(path: string): "javascript" | "typescript" | undefined {
  const ext = path.slice(path.lastIndexOf(".")).toLowerCase();
  if ([".ts", ".tsx"].includes(ext)) return "typescript";
  if ([".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return "javascript";
  return undefined;
}

function lineIndent(line: string): string {
  return line.match(/^\s*/)?.[0] ?? "";
}

function addManualStep(steps: string[], value: string): void {
  if (!steps.includes(value)) steps.push(value);
}

function insertAtLines(source: string, operations: InstrumentationOperation[]): string {
  const lines = source.split(/\r?\n/);
  // Insert from the end so line numbers stay bound to the original source.
  for (const operation of [...operations].sort((a, b) => b.line - a.line)) {
    lines.splice(operation.line - 1, 0, operation.content);
  }
  return lines.join("\n");
}

function planKey(id: string): string {
  return `instrumentation-plan/${id}`;
}

function unsafePlanPath(value: unknown): boolean {
  if (typeof value !== "string" || !value || value.length > 512 || /[\x00-\x1f]/.test(value)) return true;
  const normalized = value.replaceAll("\\", "/");
  if (isAbsolute(normalized) || /^[a-z]:/i.test(normalized)) return true;
  if (normalized.split("/").includes("..")) return true;
  const parts = normalized.split("/");
  return parts.some((part) =>
    part === ".git" || part === "node_modules" || part === ".ssh" || part === ".lightmoni" ||
    part.startsWith(".") || /^\.env(?:\.|$)/i.test(part) ||
    /^(?:\.npmrc|\.netrc|\.pypirc|credentials(?:\.json)?|secrets?(?:\..*)?|id_(?:rsa|ed25519)(?:\.pub)?)$/i.test(part) ||
    /\.(?:pem|p12|pfx|key)$/i.test(part),
  );
}

function validatePlanOperations(path: string, source: string, operations: unknown): InstrumentationOperation[] {
  if (unsafePlanPath(path) || !Array.isArray(operations) || operations.length < 1 || operations.length > 32)
    throw Error("invalid instrumentation plan");
  const lines = source.split(/\r?\n/);
  const result: InstrumentationOperation[] = [];
  for (const operation of operations) {
    if (!operation || typeof operation !== "object" || Array.isArray(operation)) throw Error("invalid instrumentation operation");
    const value = operation as Record<string, unknown>;
    if (value.op !== "insert" || !Number.isSafeInteger(value.line) || Number(value.line) < 1 || Number(value.line) > lines.length + 1 ||
      typeof value.content !== "string" || !value.content || value.content.includes("\0") || Buffer.byteLength(value.content) > MAX_FILE_BYTES)
      throw Error("invalid instrumentation operation");
    if (Object.keys(value).some((key) => !["op", "line", "content"].includes(key))) throw Error("invalid instrumentation operation");
    result.push({ op: "insert", line: Number(value.line), content: value.content });
  }
  return result;
}

async function atomicReplace(path: string, content: string, mode: number): Promise<void> {
  const temporary = resolve(path + `.lightmoni-instrumentation-${randomBytes(12).toString("hex")}.tmp`);
  try {
    await writeFile(temporary, content, { flag: "wx", mode: mode & 0o777 });
    await chmod(temporary, mode & 0o777);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * Read-only SDK onboarding scan. It never imports a project, executes package
 * scripts, follows symlinks, or writes a patch. A later proposal can produce a
 * constrained diff or hand ambiguous work to the existing isolated code_task
 * flow for an explicit review.
 */
export class InstrumentationService {
  private readonly records = new Map<string, StoredInstrumentationPlan>();
  private readonly now: () => Date;
  constructor(readonly root: string, private readonly options: InstrumentationServiceOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  private loadPlan(id: string): StoredInstrumentationPlan | undefined {
    if (!/^ip_[a-f0-9]{24}$/.test(id)) return undefined;
    const saved = this.records.get(id) ?? this.options.store?.get<StoredInstrumentationPlan>(planKey(id));
    return saved ? structuredClone(saved) : undefined;
  }

  private savePlan(id: string, value: StoredInstrumentationPlan): void {
    const serialized = JSON.stringify(value);
    if (Buffer.byteLength(serialized) > MAX_PLAN_BYTES) throw Error("instrumentation plan is too large");
    this.options.store?.put(planKey(id), structuredClone(value));
    this.records.set(id, structuredClone(value));
    if (this.records.size > 100) {
      const first = this.records.keys().next().value as string | undefined;
      if (first) this.records.delete(first);
    }
  }

  get(planID: string): InstrumentationPlan | undefined {
    return this.loadPlan(planID)?.plan;
  }

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
      if (/@lightmoni\/sdk|lightmoni-sdk|from\s+["']lightmoni["']|from\s+lightmoni\s+import|import\s+lightmoni\b|lightmoni\.record/i.test(source)) {
        packages.add("lightmoni");
        // Do not treat an arbitrary comment/variable containing "agent" as a
        // transport selection. Only explicit mode/endpoint settings count.
        const agentMode = /LIGHTMONI_MODE\s*=\s*["']agent["']|LIGHTMONI_(?:AGENT_ENDPOINT|LOCAL_TOKEN)\b|https?:\/\/(?:localhost|127(?:\.\d{1,3}){3}|\[::1\]):4318(?:[\/"'\s]|$)/i.test(source);
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
    const sdkMode: "direct" | "unknown" = sawDirectSDK && !sawAgentSDK ? "direct" : "unknown";
    return {
      plan_id: `ip_${randomBytes(12).toString("hex")}`,
      workspace,
      base_revision: revision,
      state: "scanned",
      languages: [...languages].sort(), frameworks: [...frameworks].sort(), package_managers: [...packageManagers].sort(),
      sdk: { found: packages.size > 0, packages: [...packages].sort(), versions: [...versions].sort(), mode: sdkMode, legacy_agent_config:sawAgentSDK },
      candidates,
      warnings: [
        ...(files.length >= MAX_FILES ? ["文件数量达到扫描上限，结果可能不完整"] : []),
        ...(total >= MAX_TOTAL_BYTES ? ["扫描字节数达到上限，结果可能不完整"] : []),
        ...(sawAgentSDK ? ["发现已移除的SDK→Agent配置；请迁移为中心公网引导endpoint与SDK Key"] : []),
        ...(packages.size === 0 ? ["未发现 LightMoni SDK；请确认依赖名称或手动选择插桩位置"] : []),
      ],
      files_scanned: files.length,
    };
  }

  /**
   * Produce a reviewable, deterministic source diff for the small set of
   * TypeScript/JavaScript request boundaries that can be located safely. This
   * method intentionally has no write capability. Unsupported languages,
   * ambiguous imports, one-line handlers, or missing SDK initialization become
   * manual steps instead of speculative source edits.
   */
  async propose(input: InstrumentationProposalInput, signal?: AbortSignal): Promise<InstrumentationPlan> {
    if (!input || typeof input.workspace !== "string" || !input.workspace.trim())
      throw Error("workspace is required");
    if (typeof input.intent !== "string" || !input.intent.trim() || input.intent.length > 2000)
      throw Error("intent is required");
    const service = validateProposalValue(input.service, "service", VALID_IDENTITY);
    const env = validateProposalValue(input.env, "env", VALID_IDENTITY);
    const intentWantsError = /error|exception|失败|错误/i.test(input.intent);
    const metric = validateProposalValue(input.metric ?? (intentWantsError ? "errors_total" : "requests_total"), "metric", VALID_METRIC)!;
    const table = validateProposalValue(input.table ?? "service", "table", VALID_TABLE)!;
    if (input.mode !== undefined && input.mode !== "direct")
      throw Error("invalid mode");

    const scan = await this.scan(input.workspace, signal);
    if (input.base_revision !== undefined && input.base_revision !== scan.base_revision)
      throw Error("revision conflict");
    const absolute = await safeWorkspace(this.root, input.workspace);
    const manualSteps: string[] = [], warnings = [...scan.warnings];
    if (input.mode && scan.sdk.mode !== "unknown" && scan.sdk.mode !== input.mode)
      warnings.push(`提案选择的 ${input.mode} 模式与扫描发现的 ${scan.sdk.mode} 配置不一致；应用前必须人工确认传输模式。`);
    const files = new Map<string, { source: string; candidates: InstrumentationFinding[] }>();
    for (const candidate of scan.candidates) {
      signal?.throwIfAborted();
      if (!candidate.file || files.has(candidate.file)) continue;
      // The scanner only emits relative paths. Re-check the canonical path
      // before reading it so a changed symlink cannot escape between phases.
      const target = resolve(absolute, candidate.file);
      const rel = relative(absolute, target);
      if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) continue;
      try {
        const info = await lstat(target);
        if (!info.isFile() || info.size > MAX_FILE_BYTES) continue;
        const data = await readFile(target);
        if (data.includes(0)) continue;
        files.set(candidate.file, {
          source: data.toString("utf8"),
          candidates: scan.candidates.filter((item) => item.file === candidate.file),
        });
      } catch {
        // A file can disappear during a read-only proposal. Keep the plan
        // reviewable and ask for a fresh scan rather than exposing host paths.
      }
    }

    const planFiles: InstrumentationPlanFile[] = [];
    for (const [path, value] of files) {
      signal?.throwIfAborted();
      if(scan.sdk.legacy_agent_config){addManualStep(manualSteps,"先将历史SDK→Agent配置迁移为中心直连，再重新生成插桩补丁。");break;}
      const lang = codeLanguage(path);
      if (!lang) {
        if (value.candidates.some((candidate) => candidate.kind === "request_boundary" || candidate.kind === "error_boundary" || candidate.kind === "sdk_import"))
          addManualStep(manualSteps, `请在 ${path} 的请求/错误边界手动加入 LightMoni SDK 打点；当前语言暂不生成安全补丁。`);
        continue;
      }
      const sdkImport = value.source.match(
        /import\s*\{([^}]*(?:createLightMoni|createLightMoni\s+as\s+\w+)[^}]*)\}\s*from\s*["'](@lightmoni\/sdk|lightmoni)["']/,
      );
      if (!sdkImport) {
        if (value.candidates.some((candidate) => candidate.kind === "request_boundary" || candidate.kind === "error_boundary"))
          addManualStep(manualSteps, `请确认 ${path} 使用 @lightmoni/sdk 的 createLightMoni 导入后再生成请求打点。`);
        continue;
      }
      const imported = sdkImport[1]!,
        createName = imported.match(/createLightMoni\s+as\s+([A-Za-z_$][\w$]*)/)?.[1] ?? "createLightMoni";
      const existingClient = value.source.match(
        new RegExp(`(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${createName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\(`),
      )?.[1];
      const clientName = existingClient ?? "lightmoniClient";
      const operations: InstrumentationOperation[] = [];
      const risks: string[] = [];
      const lines = value.source.split(/\r?\n/);
      if (!existingClient) {
        if (new RegExp(`\\b${clientName}\\b`).test(value.source)) {
          addManualStep(manualSteps, `请在 ${path} 选择未占用的 SDK 客户端变量名后再生成补丁。`);
          continue;
        }
        const lastImport = lines.reduce((last, line, index) => (/^\s*import\s/.test(line) ? index + 1 : last), 0);
        const optionLines = [
          `const ${clientName} = ${createName}({`,
          `  service: process.env.LIGHTMONI_SERVICE ?? ${JSON.stringify(service ?? "service")},`,
          `  env: process.env.LIGHTMONI_ENV ?? process.env.NODE_ENV ?? ${JSON.stringify(env ?? "production")},`,
        ];
        optionLines.push(`  endpoint: process.env.LIGHTMONI_ENDPOINT,`, `  key: process.env.LIGHTMONI_KEY,`);
        risks.push("请在运行环境注入中心公网引导地址与SDK Key；客户端自动同步管理员登记的内网入口。");
        optionLines.push("});");
        operations.push({ op: "insert", line: lastImport + 1, content: optionLines.join("\n") });
      }
      const boundary = value.candidates
        .filter((candidate) => candidate.kind === (intentWantsError ? "error_boundary" : "request_boundary"))
        .sort((a, b) => (a.line ?? Number.MAX_SAFE_INTEGER) - (b.line ?? Number.MAX_SAFE_INTEGER))[0];
      if (!boundary?.line) {
        addManualStep(manualSteps, `请在 ${path} 的${intentWantsError ? "错误" : "请求"}边界手动插入 ${metric}；未找到可安全展开的多行函数。`);
        continue;
      }
      const boundaryLine = boundary.line - 1;
      let bodyLine = boundaryLine;
      while (bodyLine < Math.min(lines.length, boundaryLine + 4) && !lines[bodyLine].includes("{")) bodyLine++;
      if (bodyLine >= lines.length || !lines[bodyLine].includes("{")) {
        addManualStep(manualSteps, `请在 ${path}:${boundary.line} 的请求处理函数体内手动插入 ${metric}；当前边界不是可安全展开的多行函数。`);
        continue;
      }
      const bodyIndent = lineIndent(lines[bodyLine]) + (lines[bodyLine].includes("\t") ? "\t" : "  ");
      const call = `${bodyIndent}${clientName}.record(${JSON.stringify(table)}, ${JSON.stringify(metric)}, {}, 1, 1);`;
      if (value.source.includes(`.record(${JSON.stringify(table)}, ${JSON.stringify(metric)}`)) {
        addManualStep(manualSteps, `文件 ${path} 已包含 ${metric} 打点，请人工确认是否需要重复插入。`);
        continue;
      }
      operations.push({ op: "insert", line: bodyLine + 2, content: call });
      const after = insertAtLines(value.source, operations);
      const patch = createTwoFilesPatch(path, path, value.source, after, "before", "after");
      planFiles.push({
        path,
        summary: `在${intentWantsError ? "错误" : "请求"}边界加入 ${table}.${metric} 计数，并在缺少客户端初始化时补充 LightMoni SDK 客户端。`,
        patch,
        operations,
        risks: [
          ...risks,
          "补丁只记录请求次数，不捕获请求体、Authorization、Cookie 或用户输入。",
          "请在应用前运行项目自身的格式、类型和单元检查。",
        ],
        validation_steps: ["运行项目格式化检查", "运行项目类型检查或单元测试", "启动后发送一条最小请求并验证遥测"],
      });
      if (planFiles.length >= 8) break;
    }

    if (!scan.sdk.found) addManualStep(manualSteps, "先安装并初始化受支持的 LightMoni SDK，再重新扫描 workspace。");
    if (scan.sdk.mode === "unknown" && scan.sdk.found) addManualStep(manualSteps, "扫描未确定中心直连配置；应用前请配置中心endpoint与SDK Key。");
    if (!planFiles.length && !manualSteps.length)
      addManualStep(manualSteps, "未找到可安全自动插桩的请求边界，请人工选择文件和插入位置。");
    const validationSteps = [...new Set(planFiles.flatMap((file) => file.validation_steps))];
    if (!validationSteps.length) validationSteps.push("确认 SDK 已配置 service/env、endpoint 和凭据，再执行项目自身的检查");
    const plan: InstrumentationPlan = {
      plan_id: `ip_${randomBytes(12).toString("hex")}`,
      workspace: input.workspace,
      base_revision: scan.base_revision,
      state: "awaiting_approval",
      intent: input.intent.trim(),
      files: planFiles,
      manual_steps: manualSteps,
      warnings,
      validation_steps: validationSteps,
    };
    const before: Record<string, string> = {};
    for (const file of plan.files) {
      const snapshot = files.get(file.path)?.source;
      if (snapshot === undefined) throw Error("instrumentation source disappeared");
      before[file.path] = snapshot;
    }
    this.savePlan(plan.plan_id, { plan, before, applied: null });
    return plan;
  }

  async apply(planID: string, input: InstrumentationApplyInput, signal?: AbortSignal): Promise<InstrumentationApplyResult> {
    if (!/^ip_[a-f0-9]{24}$/.test(planID)) throw Error("instrumentation plan not found");
    if (!input || typeof input.base_revision !== "string" || !input.base_revision || input.approval !== "apply")
      throw Error("approval_required");
    if (input.idempotency_key !== undefined &&
      (typeof input.idempotency_key !== "string" || input.idempotency_key.length < 1 || input.idempotency_key.length > 128 || /[\x00-\x1f]/.test(input.idempotency_key)))
      throw Error("invalid idempotency key");
    const record = this.loadPlan(planID);
    if (!record) throw Error("instrumentation plan not found");
    if (record.applied) {
      // Applying a completed plan again is safe and returns the original
      // receipt. A changed key cannot make the source write a second time.
      return { ...record.applied, idempotent: true };
    }
    if (record.plan.state !== "awaiting_approval" || input.base_revision !== record.plan.base_revision)
      throw Error("revision conflict");
    if (!record.plan.files.length) throw Error("instrumentation plan has no changes");
    signal?.throwIfAborted();
    const workspace = await safeWorkspace(this.root, record.plan.workspace);
    const current = await this.scan(record.plan.workspace, signal);
    if (current.base_revision !== record.plan.base_revision) throw Error("revision conflict");
    const replacements: Array<{ path: string; target: string; before: string; after: string; mode: number }> = [];
    let total = 0;
    for (const file of record.plan.files) {
      signal?.throwIfAborted();
      const before = record.before[file.path];
      if (before === undefined || unsafePlanPath(file.path)) throw Error("invalid instrumentation plan");
      const target = resolve(workspace, file.path.replaceAll("\\", "/"));
      const rel = relative(workspace, target);
      if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw Error("workspace path is outside root");
      const info = await lstat(target).catch(() => undefined);
      if (!info || !info.isFile()) throw Error("instrumentation target is not a regular file");
      const canonical = await realpath(target);
      if (canonical !== target) throw Error("instrumentation target is a symbolic link");
      const currentSource = await readFile(target);
      if (currentSource.includes(0) || currentSource.toString("utf8") !== before) throw Error("revision conflict");
      const operations = validatePlanOperations(file.path, before, file.operations);
      const after = insertAtLines(before, operations);
      if (after.includes("\0") || Buffer.byteLength(after) > MAX_FILE_BYTES) throw Error("instrumentation target exceeds size limit");
      total += Buffer.byteLength(after);
      if (total > MAX_TOTAL_BYTES) throw Error("instrumentation plan exceeds size limit");
      replacements.push({ path: file.path, target, before, after, mode: info.mode });
    }
    const written: typeof replacements = [];
    try {
      for (const replacement of replacements) {
        signal?.throwIfAborted();
        await atomicReplace(replacement.target, replacement.after, replacement.mode);
        written.push(replacement);
      }
    } catch (error) {
      for (const replacement of written.reverse()) {
        try { await atomicReplace(replacement.target, replacement.before, replacement.mode); } catch { /* retain original error */ }
      }
      throw error;
    }
    const resultRevision = (await this.scan(record.plan.workspace, signal)).base_revision;
    const applied: InstrumentationApplyResult = {
      plan_id: planID,
      state: "applied",
      result_revision: resultRevision,
      changed_files: replacements.map((replacement) => replacement.path),
      applied_at: this.now().toISOString(),
      ...(input.idempotency_key ? { idempotent: false } : {}),
    };
    this.savePlan(planID, { ...record, applied, idempotency_key: input.idempotency_key });
    return applied;
  }
}
