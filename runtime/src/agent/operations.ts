import { spawn } from "node:child_process";
import type { OperationPayload, OperationExecutionContext, OperationExecutionResult } from "../operations/types.js";
import type { ExecutionReceipt } from "./executor.js";
import { executeWebsite, websiteDefinition } from "../operations/websites.js";
import { executeCertificate, certificateDefinition } from "../operations/certificates.js";
import { executeCompose, composeDefinition } from "../operations/containers.js";
import { executeBackup, backupDefinition } from "../operations/backups.js";
import { acquireOperationLock } from "./operation-lock.js";
import { OperationRejectedError } from "../operations/errors.js";

export const operationCapabilities = ["operations.website", "operations.certificate", "operations.compose", "operations.backup"];
export const operationCommand: OperationExecutionContext["command"] = (file, args, options = {}) => new Promise((resolve, reject) => {
  const allowed = ["PATH", "HOME", "TMPDIR", "TEMP", "SystemRoot", "SSL_CERT_FILE", "SSL_CERT_DIR"];
  const env = Object.fromEntries(allowed.flatMap(key => process.env[key] ? [[key, process.env[key]!]] : []));
  const grouped = process.platform !== "win32";
  const child = spawn(file, args, { cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"], detached: grouped, shell: false, signal: options.signal, killSignal: "SIGKILL", env: { ...env, LC_ALL: "C", LANG: "C" } });
  let stdout = "", stderr = "", settled = false;
  const finish = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); if (error) { if (grouped && child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch {} } child.kill("SIGKILL"); reject(error); } else resolve({ stdout, stderr }); };
  const timer = setTimeout(() => finish(Object.assign(Error("operation_command_timeout"), { code: "operation_command_timeout" })), Math.min(600_000, options.timeoutMs ?? 30_000));
  const append = (chunk: Buffer, out: boolean) => { if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) + chunk.length > 1 << 20) finish(Object.assign(Error("operation_output_limit"), { code: "operation_output_limit" })); else if (out) stdout += chunk; else stderr += chunk; };
  child.stdout.on("data", x => append(x, true)); child.stderr.on("data", x => append(x, false));
  child.on("error", () => finish(Object.assign(Error("operation_dependency_unavailable"), { code: "operation_dependency_unavailable" })));
  child.on("close", code => finish(code === 0 ? undefined : Object.assign(Error("operation_command_failed"), { code: "operation_command_failed" })));
  child.stdin.on("error", () => {}); child.stdin.end(options.stdin);
});

function secrets(config: any, all = false): string[] {
  if (!config || typeof config !== "object") return all && typeof config === "string" && config.length >= 4 ? [config] : [];
  return Object.entries(config).flatMap(([key, value]) => secrets(value, all || /private|password|secret|token|credential|environment/i.test(key)));
}
export async function executeOperation(payload: OperationPayload, context: OperationExecutionContext, emit: (event: {phase: string; summary: string}) => Promise<void>): Promise<ExecutionReceipt> {
  const started = context.now().toISOString();
  let begun = false;
  let lock: Awaited<ReturnType<typeof acquireOperationLock>> | undefined, keepLock = false;
  const clean = (v: any): any => {
    if (typeof v === "string") { for (const secret of secrets(payload.resource.config)) v = v.split(secret).join("[redacted]"); return v.replace(/-----BEGIN[\s\S]*?PRIVATE KEY-----[\s\S]*?-----END[\s\S]*?PRIVATE KEY-----/g, "[redacted]"); }
    if (Array.isArray(v)) return v.slice(0, 1000).map(clean);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, /private_key|password|secret|token|credential/i.test(k) ? "[redacted]" : clean(x)]));
    return v;
  };
  try {
    if (payload.version !== 1 || !/^[a-f0-9]{32}$/.test(payload.operation_id) || !/^[a-f0-9]{32}$/.test(payload.resource.id)) throw Error("invalid_operations_payload");
    const definition = [websiteDefinition, certificateDefinition, composeDefinition, backupDefinition].find(d => d.kind === payload.resource.kind);
    if (!definition?.operations.includes(payload.operation)) throw Error("unsupported_operations_action");
    const config = definition.validate(payload.resource.config);
    definition.validateInput(payload.operation, payload.input, config);
    if (!definition.readOnly.includes(payload.operation)) lock = await acquireOperationLock(context.dataDir, payload.operation_id, context.now());
    await emit({ phase: "accepted", summary: "Agent accepted the approved operation" });
    context.signal.throwIfAborted();
    await emit({ phase: "staging", summary: "Preparing registered operation prerequisites" });
    await emit({ phase: "activating", summary: "Executing the approved bounded operation" });
    begun = true;
    const executors: Record<string, (p: OperationPayload, c: OperationExecutionContext) => Promise<OperationExecutionResult>> = { website: executeWebsite, certificate: executeCertificate, compose: executeCompose, backup: executeBackup };
    const executor = executors[payload.resource.kind];
    if (!executor) throw Error("unsupported_operations_kind");
    const result = await executor(payload, context);
    context.signal.throwIfAborted();
    await emit({ phase: "verifying", summary: "Recording the operation verification evidence" });
    const data = clean(result.data);
    if (payload.operation === "logs") {
      for (const key of ["text", "logs"]) if (typeof data[key] === "string") while (Buffer.byteLength(JSON.stringify(data)) > 48 << 10 && data[key].length) { data[key] = data[key].slice(Math.max(1, Math.ceil(data[key].length / 8))); data.truncated = true; }
    }
    if (Buffer.byteLength(JSON.stringify(data)) > 60 << 10) throw Object.assign(Error("operation_result_limit"), { code: "operation_result_limit" });
    const unknown = result.data.status === "unknown";
    keepLock = unknown;
    return { state: unknown ? "unknown" : result.verified ? "succeeded" : "failed", code: unknown ? "unknown_execution_result" : result.verified ? "" : "operation_not_verified", summary: result.verified ? "Registered operation completed and verified" : "Registered operation requires review", snapshot: { health: { healthy: result.verified }, operations: { operation_id: payload.operation_id, resource_id: payload.resource.id, data } }, started_at: started, finished_at: context.now().toISOString() };
  } catch (e) {
    const message = e instanceof Error ? e.message : "";
    // Domain errors describe rejected prerequisites or a verified compensation.
    // Unexpected/OS errors after entering an executor can occur after the live
    // change but before its metadata commit (EIO/ENOSPC, for example).
    // Never release the writer fence merely because that write threw.
    const domainFailure = e instanceof OperationRejectedError || /^[A-Z][A-Z0-9_]{0,95}$/.test(message) && !(e as any)?.code;
    const unknown = begun && (context.signal.aborted || /RECOVERY_FAILED$/.test(message) || !domainFailure);
    keepLock = unknown;
    const code = typeof (e as any)?.code === "string" && /^[a-z][a-z0-9_]{0,63}$/.test((e as any).code) ? (e as any).code : /^[A-Z][A-Z0-9_]{0,63}$/.test(message) ? message.toLowerCase() : "operation_failed";
    return { state: unknown ? "unknown" : "failed", code, summary: unknown ? "Operation interrupted; inspect target before retrying" : "Registered operation failed; review prerequisites and configuration", snapshot: {}, started_at: started, finished_at: context.now().toISOString() };
  } finally { await lock?.finish(keepLock).catch(() => {}); }
}
