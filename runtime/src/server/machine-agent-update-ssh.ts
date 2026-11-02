import { SSHError } from "./machine-ssh.js";

export interface AgentUpdateRemoteRelease {
  version: string; source_revision: string; build_id: string; state_schema: 1;
  artifact_sha256: string; arch: "amd64" | "arm64"; fingerprint: string; boot_id?: string;
}
export interface AgentUpdateProbe {
  schema: 1; ready: boolean; agent_id: string; arch: "amd64" | "arm64";
  service_active: boolean; lifecycle_locked: boolean; operation_lock: boolean;
  current: AgentUpdateRemoteRelease & { boot_id: string }; previous: AgentUpdateRemoteRelease | null;
}
export interface AgentUpdateStartRequest {
  operation_id: string; expected_agent_id: string; expected_fingerprint: string; expected_service_active: boolean;
  start_deadline: string;
  action: "upgrade" | "rollback"; target: Omit<AgentUpdateRemoteRelease, "fingerprint"> & { fingerprint?: string };
  confirm_timeout_seconds?: number;
}
export interface AgentUpdateRemoteStatus {
  schema: 1; operation_id: string; agent_id: string;
  status: "accepted" | "preparing" | "switching" | "waiting_confirmation" | "succeeded" | "rolled_back" | "failed" | "rollback_failed";
  from: AgentUpdateRemoteRelease & { boot_id: string }; target: AgentUpdateStartRequest["target"];
  local_health: { service_active: boolean; identity_matches: boolean; release_matches: boolean; boot_id: string };
  started_at: string; updated_at: string; finished_at?: string; confirmation_deadline?: string;
  error_code?: string; restored_fingerprint?: string; uninstaller_updated?: boolean;
}
export const ORDINARY_AGENT_SERVICE_SHA256 = "651b2b126af0e96dfd26bbe6fc3e438f2f1a71814cff4009ec8fdeeaadb21bbf";
const sha = /^[a-f0-9]{64}$/, op = /^[a-f0-9]{32}$/;
const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
const privileged = (script: string) => `if test "$(id -u)" = 0; then /bin/sh -c ${quote(script)}; else sudo -n /bin/sh -c ${quote(script)}; fi`;
const operation = (value: string) => { if (!op.test(value)) throw Error("invalid operation ID"); return value; };
const parseJSON = (value: string) => {
  if (Buffer.byteLength(value) > 32768) throw new SSHError("invalid_response");
  try { return JSON.parse(value); } catch { throw new SSHError("invalid_response"); }
};
function release(value: any, fingerprint = true) {
  return value && typeof value.version === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(value.version)
    && typeof value.source_revision === "string" && (value.source_revision === "" || /^[a-f0-9]{40}$/.test(value.source_revision))
    && typeof value.build_id === "string" && (value.build_id === "" || /^[A-Za-z0-9._-]{1,128}$/.test(value.build_id))
    && value.state_schema === 1 && typeof value.artifact_sha256 === "string" && (value.artifact_sha256 === "" || sha.test(value.artifact_sha256))
    && ["amd64", "arm64"].includes(value.arch) && (!fingerprint || sha.test(value.fingerprint ?? ""));
}
const boot = (value: unknown) => typeof value === "string" && (value === "" || /^[a-f0-9-]{36}$/.test(value));
function safeRelease(value: any, includeFingerprint = true): AgentUpdateRemoteRelease {
  return { version: value.version, source_revision: value.source_revision, build_id: value.build_id, state_schema: 1, artifact_sha256: value.artifact_sha256, arch: value.arch,
    ...(includeFingerprint || typeof value.fingerprint === "string" ? { fingerprint: value.fingerprint } : {}), ...(typeof value.boot_id === "string" ? { boot_id: value.boot_id } : {}) } as AgentUpdateRemoteRelease;
}
export function parseAgentUpdateProbe(output: string): AgentUpdateProbe {
  const v = parseJSON(output);
  if (!v || v.schema !== 1 || typeof v.ready !== "boolean" || !/^[A-Za-z0-9._:-]{1,128}$/.test(v.agent_id ?? "") || !["amd64", "arm64"].includes(v.arch)
    || ["service_active", "lifecycle_locked", "operation_lock"].some(key => typeof v[key] !== "boolean") || !release(v.current) || !boot(v.current.boot_id)
    || !(v.previous === null || release(v.previous))) throw new SSHError("invalid_response");
  return { schema: 1, ready: v.ready, agent_id: v.agent_id, arch: v.arch, service_active: v.service_active, lifecycle_locked: v.lifecycle_locked, operation_lock: v.operation_lock, current: { ...safeRelease(v.current), boot_id: v.current.boot_id }, previous: v.previous ? safeRelease(v.previous) : null };
}
export function parseAgentUpdateStatus(output: string): AgentUpdateRemoteStatus {
  const v = parseJSON(output);
  if (!v || v.schema !== 1 || !op.test(v.operation_id ?? "") || !/^[A-Za-z0-9._:-]{1,128}$/.test(v.agent_id ?? "")
    || !["accepted", "preparing", "switching", "waiting_confirmation", "succeeded", "rolled_back", "failed", "rollback_failed"].includes(v.status)
    || !release(v.from) || !boot(v.from.boot_id) || !release(v.target, false) || !v.local_health
    || ["service_active", "identity_matches", "release_matches"].some(key => typeof v.local_health[key] !== "boolean") || !boot(v.local_health.boot_id)
    || ["started_at", "updated_at"].some(key => typeof v[key] !== "string" || !Number.isFinite(Date.parse(v[key])))
    || ["finished_at", "confirmation_deadline"].some(key => v[key] !== undefined && (typeof v[key] !== "string" || !Number.isFinite(Date.parse(v[key]))))
    || v.error_code !== undefined && !/^[a-z_]{1,80}$/.test(v.error_code) || v.restored_fingerprint !== undefined && !sha.test(v.restored_fingerprint)
    || v.uninstaller_updated !== undefined && typeof v.uninstaller_updated !== "boolean") throw new SSHError("invalid_response");
  return { schema: 1, operation_id: v.operation_id, agent_id: v.agent_id, status: v.status, from: { ...safeRelease(v.from), boot_id: v.from.boot_id }, target: safeRelease(v.target, false),
    local_health: { service_active: v.local_health.service_active, identity_matches: v.local_health.identity_matches, release_matches: v.local_health.release_matches, boot_id: v.local_health.boot_id },
    started_at: v.started_at, updated_at: v.updated_at,
    ...(v.finished_at ? { finished_at: v.finished_at } : {}), ...(v.confirmation_deadline ? { confirmation_deadline: v.confirmation_deadline } : {}),
    ...(v.error_code ? { error_code: v.error_code } : {}), ...(v.restored_fingerprint ? { restored_fingerprint: v.restored_fingerprint } : {}),
    ...(v.uninstaller_updated !== undefined ? { uninstaller_updated: v.uninstaller_updated } : {}) };
}

// This self-contained probe runs with the already installed bundled Node even
// before a host has a maintenance helper. Keep fingerprint construction equal
// to AgentMaintenance.fingerprint (tested by the executor fixtures).
export const agentUpdateProbeSource = String.raw`const fs=require('node:fs'),p=require('node:path'),c=require('node:crypto'),cp=require('node:child_process');
const sha=v=>c.createHash('sha256').update(v).digest('hex'),SHA=/^[a-f0-9]{64}$/,OP=/^[a-f0-9]{32}$/;
function safe(f,dir=false){let q=p.resolve(f);for(;;){const s=fs.lstatSync(q);if(s.isSymbolicLink()||s.uid!==0||(s.mode&18)!==0||q===f&&(dir?!s.isDirectory():!s.isFile()))throw Error();if(q==='/')break;q=p.dirname(q);}return f;}
function json(f,max=65536){const s=fs.lstatSync(f);if(s.isSymbolicLink()||!s.isFile()||s.size>max)throw Error();return JSON.parse(fs.readFileSync(f,'utf8'));}
function meta(r){safe(r,true);const m=json(safe(p.join(r,'release.json')),16384);if(!/^[A-Za-z0-9._-]{1,128}$/.test(m.version||'')||m.platform!=='linux'||!['amd64','arm64'].includes(m.arch))throw Error();const n=m.state_schema===1&&/^[a-f0-9]{40}$/.test(m.source_revision||'')&&/^[A-Za-z0-9._-]{1,128}$/.test(m.build_id||'');if(!n)throw Error();if(m.node_binary_sha256!==undefined&&(!SHA.test(m.node_binary_sha256)||sha(fs.readFileSync(safe(p.join(r,'node'))))!==m.node_binary_sha256))throw Error();let a='';try{const x=json(safe(p.join(r,'installation.json')),4096);if(x.schema!==1||!SHA.test(x.artifact_sha256||''))throw Error();a=x.artifact_sha256;}catch(e){if(e.code!=='ENOENT')throw e;}return {version:m.version,source_revision:m.source_revision,build_id:m.build_id,state_schema:1,artifact_sha256:a,arch:m.arch};}
function fp(r,l='/usr/local/bin/lightmoni-agent',s='/etc/systemd/system/lightmoni-agent.service'){const release=meta(r),launcher=fs.readFileSync(safe(l)),service=fs.readFileSync(safe(s)),manifest=fs.readFileSync(safe(p.join(r,'release.json'))),node=sha(fs.readFileSync(safe(p.join(r,'node')))),entrypoint=sha(fs.readFileSync(safe(p.join(r,'app/runtime/dist/agent/main.js'))));const uninstaller=sha(fs.readFileSync(safe(p.join(r,'uninstall.sh'))));return {...release,fingerprint:sha(JSON.stringify({release_path:r,release,manifest:sha(manifest),launcher:sha(launcher),service:sha(service),node,entrypoint,uninstaller}))};}
function run(f,a){return cp.execFileSync(f,a,{encoding:'utf8',timeout:10000,maxBuffer:4194304,stdio:['ignore','pipe','ignore']}).trim();}
function sys(v){return run('systemctl',['show','lightmoni-agent.service','--property='+v,'--value']);}
try{safe('/opt/lightmoni-agent',true);const id=json('/var/lib/lightmoni-agent/identity.json',4096);if(!/^[A-Za-z0-9._:-]{1,128}$/.test(id.agent_id||''))throw Error();const sy=fs.lstatSync('/opt/lightmoni-agent/current'),r=fs.realpathSync('/opt/lightmoni-agent/current');if(!sy.isSymbolicLink()||sy.uid!==0||p.dirname(r)!=='/opt/lightmoni-agent/releases')throw Error();const current=fp(r),state=sys('ActiveState');if(sys('LoadState')!=='loaded'||sys('FragmentPath')!=='/etc/systemd/system/lightmoni-agent.service'||!['active','inactive','failed'].includes(state))throw Error();let local={};try{local=JSON.parse(run('/usr/local/bin/lightmoni-agent',['status','--config','/etc/lightmoni-agent/config.json']));}catch{}current.boot_id=local.agent_id===id.agent_id&&/^[a-f0-9-]{36}$/.test(local.boot_id||'')?local.boot_id:'';let previous=null;try{const x=json(safe('/opt/lightmoni-agent/previous.json'));if(x.schema!==1||!OP.test(x.operation_id||''))throw Error();const d='/opt/lightmoni-agent/updates/'+x.operation_id;safe(d,true);previous=fp(x.release_path,p.join(d,'previous-launcher'),p.join(d,'previous-service'));if(previous.fingerprint!==x.fingerprint)throw Error();if(sha(fs.readFileSync(safe(p.join(d,'previous-service'))))!=='${ORDINARY_AGENT_SERVICE_SHA256}')previous=null;}catch(e){if(e.code!=='ENOENT')throw e;}let busy=fs.existsSync('/var/lib/lightmoni-agent/operations/execution.lock');for(const f of ['agent-job-state.json','task-run-state.json'])try{const x=json('/var/lib/lightmoni-agent/'+f);busy ||=typeof x.id==='string'&&!!x.id;}catch(e){if(e.code!=='ENOENT')busy=true;}const arch=process.arch==='x64'?'amd64':process.arch;process.stdout.write(JSON.stringify({schema:1,ready:current.arch===arch,agent_id:id.agent_id,arch,service_active:state==='active',lifecycle_locked:fs.existsSync('/run/lightmoni-agent-lifecycle.lock'),operation_lock:busy,current,previous})+'\n');}catch{process.stdout.write('{"error_code":"unmanaged_installation"}\n');process.exitCode=1;}`;
export function agentUpdateProbeCommand() { return privileged(`set -eu\n/opt/lightmoni-agent/current/node -e ${quote(agentUpdateProbeSource)}`); }

export function agentUpdateStartCommand(input: {
  endpoint: string; machineID: string; operationID: string;
  scripts: { "update.sh": string; "update-runner.mjs": string }; bundleSHA?: string;
  request: AgentUpdateStartRequest;
}) {
  operation(input.operationID);
  if (!/^[a-f0-9]{16}$/.test(input.machineID) || input.request.operation_id !== input.operationID || !sha.test(input.scripts["update.sh"]) || !sha.test(input.scripts["update-runner.mjs"]) || input.bundleSHA !== undefined && !sha.test(input.bundleSHA)) throw Error("invalid update command");
  const endpoint = new URL(input.endpoint);
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw Error("invalid update endpoint");
  const base = input.endpoint.replace(/\/$/, "") + `/api/v1/machines/${input.machineID}/agent-updates/${input.operationID}/downloads/`;
  const request64 = Buffer.from(JSON.stringify(input.request)).toString("base64");
  const files: Array<[string, string]> = [["update.sh", input.scripts["update.sh"]], ["update-runner.mjs", input.scripts["update-runner.mjs"]], ...(input.bundleSHA ? [["bundle.tar.gz", input.bundleSHA] as [string, string]] : [])];
  const script = `set -eu
umask 077
tmp_dir=$(mktemp -d /opt/lightmoni-agent/.update-bootstrap.XXXXXX)
trap 'rm -rf "$tmp_dir"' EXIT HUP INT TERM
/opt/lightmoni-agent/current/node -e ${quote(`const fs=require('node:fs');let raw='';process.stdin.on('data',v=>{raw+=v;if(raw.length>4096)process.exit(1)});process.stdin.on('end',()=>{try{const t=JSON.parse(raw).download_token;if(typeof t!=='string'||!/^[-_A-Za-z0-9]{20,512}$/.test(t))throw Error();const d=process.argv[1];fs.writeFileSync(d+'/curl.conf','header = "Authorization: Bearer '+t+'"\\n',{mode:0o600});const r=JSON.parse(Buffer.from('${request64}','base64'));r.archive_path=d+'/bundle.tar.gz';fs.writeFileSync(d+'/request.json',JSON.stringify(r),{mode:0o600});}catch{process.exitCode=1;}});`)} "$tmp_dir"
${files.map(([file, hash]) => `curl --fail --silent --show-error --proto '=https' --tlsv1.2 --max-time 120 --config "$tmp_dir/curl.conf" -o "$tmp_dir/${file}" ${quote(base + file)}\nprintf '%s  %s\\n' ${quote(hash)} "$tmp_dir/${file}" | sha256sum --check --status`).join("\n")}
sh "$tmp_dir/update.sh" start < "$tmp_dir/request.json"`;
  return privileged(script);
}
function helper(command: string, request: Record<string, string>) {
  operation(request.operation_id);
  return privileged(`set -eu\nprintf '%s' ${quote(JSON.stringify(request))} | /opt/lightmoni-agent/current/node /opt/lightmoni-agent/update-runner.mjs ${command}`);
}
export const agentUpdateStatusCommand = (operationID: string) => helper("status", { operation_id: operationID });
export const agentUpdateCommitCommand = (operationID: string, expectedBootID: string, targetSHA: string) => {
  if (!/^[a-f0-9-]{36}$/.test(expectedBootID) || !sha.test(targetSHA)) throw Error("invalid commit");
  return helper("commit", { operation_id: operationID, expected_boot_id: expectedBootID, expected_target_sha256: targetSHA });
};
export const agentUpdateRollbackCommand = (operationID: string) => helper("rollback", { operation_id: operationID });
