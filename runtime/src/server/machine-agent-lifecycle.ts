import { SSHError } from "./machine-ssh.js";
import { agentMaintenanceShellGuards } from "../shared/agent-maintenance-shell.js";

const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
export const retainedAgentPaths = ["/etc/lightmoni-agent", "/var/lib/lightmoni-agent"];
export const removedAgentPaths = ["/etc/systemd/system/lightmoni-agent.service", "/usr/local/bin/lightmoni-agent", "/opt/lightmoni-agent", "/usr/local/sbin/lightmoni-agent-uninstall"];
export const freshAgentGuard = `if test -e /usr/local/bin/lightmoni-agent || test -L /usr/local/bin/lightmoni-agent || test -e /opt/lightmoni-agent || test -e /etc/systemd/system/lightmoni-agent.service || test -e /etc/lightmoni-agent/config.json || test -e /var/lib/lightmoni-agent/identity.json; then echo 'Existing Agent installation detected; inspect or uninstall it before a fresh installation.' >&2; exit 1; fi`;
const privileged = (script: string) => `if test "$(id -u)" = 0; then /bin/sh -c ${quote(script)}; else sudo -n /bin/sh -c ${quote(script)}; fi`;

/** The identity reader deliberately emits only a bounded, validated agent ID. */
const identity = `identity=/var/lib/lightmoni-agent/identity.json
if test -L "$identity" || ! test -f "$identity" || test "$(wc -c < "$identity")" -gt 4096; then exit 42; fi
agent_id=$(sed -n 's/.*"agent_id"[[:space:]]*:[[:space:]]*"\\([A-Za-z0-9._:-]*\\)".*/\\1/p' "$identity")
case "$agent_id" in ''|*[!A-Za-z0-9._:-]*) exit 42;; esac
test "\${#agent_id}" -le 256 || exit 42`;
const observation = `printf 'LMAGENT=1\\nagent_id=%s\\n' "$agent_id"
if test -e /usr/local/bin/lightmoni-agent || test -L /usr/local/bin/lightmoni-agent || test -e /opt/lightmoni-agent || test -e /etc/systemd/system/lightmoni-agent.service; then echo installation=present; else echo installation=absent; fi
if test -f /usr/local/bin/lightmoni-agent && test -d /opt/lightmoni-agent && test -f /etc/systemd/system/lightmoni-agent.service; then echo program_complete=1; else echo program_complete=0; fi
service_state=$(systemctl show lightmoni-agent.service --property=ActiveState --value)
fragment=$(systemctl show lightmoni-agent.service --property=FragmentPath --value)
load_state=$(systemctl show lightmoni-agent.service --property=LoadState --value)
case "$fragment:$load_state" in /etc/systemd/system/lightmoni-agent.service:loaded|:not-found) echo unit_managed=1;; *) echo unit_managed=0;; esac
case "$service_state" in active) echo service_running=1;; inactive|failed) echo service_running=0;; *) exit 42;; esac
if test -e /run/lightmoni-agent-lifecycle.lock; then echo lifecycle_locked=1; else echo lifecycle_locked=0; fi
if test -e /var/lib/lightmoni-agent/operations/execution.lock || { test -f /var/lib/lightmoni-agent/agent-job-state.json && grep -Eq '"id"[[:space:]]*:[[:space:]]*"[^"]+"' /var/lib/lightmoni-agent/agent-job-state.json; } || { test -f /var/lib/lightmoni-agent/task-run-state.json && grep -Eq '"id"[[:space:]]*:[[:space:]]*"[^"]+"' /var/lib/lightmoni-agent/task-run-state.json; }; then echo operation_lock=1; else echo operation_lock=0; fi
if test -d /etc/lightmoni-agent && test -d /var/lib/lightmoni-agent; then echo data_retained=1; else echo data_retained=0; fi`;
export const agentProbeCommand = () => privileged(`set -eu\n${identity}\n${observation}`);

export function parseAgentProbe(output: string) {
  const entries = output.trim().split(/\r?\n/).map(line => /^([a-z_]+|LMAGENT)=([A-Za-z0-9._:-]+)$/.exec(line));
  if (entries.length !== 9 || entries.some(value => !value)) throw new SSHError("invalid_response");
  const values = new Map(entries.map(value => [value![1], value![2]]));
  if (values.size !== 9 || values.get("LMAGENT") !== "1" || !/^[A-Za-z0-9._:-]{1,256}$/.test(values.get("agent_id") ?? "") || !["present", "absent"].includes(values.get("installation") ?? "") || ["service_running", "operation_lock", "data_retained", "unit_managed", "lifecycle_locked", "program_complete"].some(name => !["0", "1"].includes(values.get(name) ?? ""))) throw new SSHError("invalid_response");
  return { agent_id: values.get("agent_id")!, installation: values.get("installation") as "present" | "absent", service_running: values.get("service_running") === "1", operation_lock: values.get("operation_lock") === "1", program_complete: values.get("program_complete") === "1", lifecycle_locked: values.get("lifecycle_locked") === "1", unit_managed: values.get("unit_managed") === "1", data_retained: values.get("data_retained") === "1" };
}

/** All paths and actions are fixed. No script or path is accepted from a request. */
export function agentUninstallCommand(expectedID: string) {
  if (!/^[A-Za-z0-9._:-]{1,256}$/.test(expectedID)) throw Error("invalid agent ID");
  return privileged(`set -eu
umask 077
${agentMaintenanceShellGuards}
if [ -e /etc/lightmoni-executor ] || [ -L /etc/lightmoni-executor ] || [ -e /opt/lightmoni-executor ] || [ -L /opt/lightmoni-executor ]; then lm_refuse 'Remove the privileged executor before removing the ordinary Agent'; fi
lm_assert_paths
lm_assert_no_operations
lock=/run/lightmoni-agent-lifecycle.lock
mkdir "$lock" || { echo 'Agent lifecycle operation already in progress.' >&2; exit 1; }
trap 'rmdir "$lock"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
${identity}
test "$agent_id" = ${quote(expectedID)} || exit 42
fragment=$(systemctl show lightmoni-agent.service --property=FragmentPath --value)
test "$fragment" = /etc/systemd/system/lightmoni-agent.service || { echo 'Non-managed Agent unit; no files removed.' >&2; exit 1; }
if test -e /var/lib/lightmoni-agent/operations/execution.lock || { test -f /var/lib/lightmoni-agent/agent-job-state.json && grep -Eq '"id"[[:space:]]*:[[:space:]]*"[^"]+"' /var/lib/lightmoni-agent/agent-job-state.json; } || { test -f /var/lib/lightmoni-agent/task-run-state.json && grep -Eq '"id"[[:space:]]*:[[:space:]]*"[^"]+"' /var/lib/lightmoni-agent/task-run-state.json; }; then echo 'Agent has an unfinished operation.' >&2; exit 1; fi
systemctl stop lightmoni-agent.service
service_state=$(systemctl show lightmoni-agent.service --property=ActiveState --value)
case "$service_state" in inactive|failed) ;; *) echo 'Agent did not stop; files retained.' >&2; exit 1;; esac
lm_assert_paths
lm_assert_no_operations
systemctl disable lightmoni-agent.service
rm -f /etc/systemd/system/lightmoni-agent.service /usr/local/bin/lightmoni-agent
rm -rf /opt/lightmoni-agent
systemctl daemon-reload
load_state=$(systemctl show lightmoni-agent.service --property=LoadState --value)
test "$load_state" = not-found || { echo 'Agent unit still exists.' >&2; exit 1; }
rmdir "$lock"
trap - EXIT HUP INT TERM
${identity}
${observation}`);
}

/** Token arrives only through SSH stdin. curl's credential file is mode 0600. */
export function agentBootstrapCommand(endpoint: string, version: string) {
  const script = `set -eu
${freshAgentGuard}
umask 077
IFS= read -r enrollment_token
case "$enrollment_token" in lm_enroll_*) ;; *) exit 1;; esac
case "$enrollment_token" in *[!A-Za-z0-9_-]*) exit 1;; esac
tmp_dir=$(mktemp -d /tmp/lightmoni-agent-bootstrap.XXXXXX)
trap 'rm -rf "$tmp_dir"' EXIT HUP INT TERM
printf 'header = "Authorization: Bearer %s"\\n' "$enrollment_token" > "$tmp_dir/curl.conf"
curl --fail --silent --show-error --proto '=https' --tlsv1.2 --max-time 120 --config "$tmp_dir/curl.conf" -o "$tmp_dir/install.sh" ${quote(endpoint.replace(/\/$/, "") + "/downloads/agent/install.sh")}
chmod 700 "$tmp_dir/install.sh"
printf '%s\\n' "$enrollment_token" | sh "$tmp_dir/install.sh" --fresh --endpoint ${quote(endpoint)} --version ${quote(version)} --enrollment-token-stdin`;
  return privileged(script);
}

export interface AgentRemovalObservation {
  agent_id: string; identity_state: "valid" | "missing" | "invalid" | "unsafe"; identity_sha256: string; program_sha256: string;
  installation: "present" | "absent"; program_complete: boolean; unit_managed: boolean; service_running: boolean;
  lifecycle_locked: boolean; operation_lock: boolean; paths_safe: boolean; config_present: boolean; data_present: boolean;
}
const removalObservation = `identity=/var/lib/lightmoni-agent/identity.json
agent_id=-
identity_sha256=-
identity_state=missing
if test -L "$identity"; then identity_state=unsafe
elif test -e "$identity"; then
  identity_state=unsafe
  if test -f "$identity" && test -r "$identity" && test "$(wc -c < "$identity")" -le 4096; then
    identity_state=invalid
    identity_sha256=$(sha256sum "$identity") || exit 42
    identity_sha256=\${identity_sha256%% *}
    identity_json=$(LC_ALL=C tr '\\n\\r\\t' '   ' < "$identity")
    if printf '%s' "$identity_json" | LC_ALL=C grep -Eq '^[ ]*[{][ ]*"(agent_id|host_id)"[ ]*:[ ]*"[A-Za-z0-9._:-]*"([ ]*,[ ]*"(agent_id|host_id)"[ ]*:[ ]*"[A-Za-z0-9._:-]*")*[ ]*[}][ ]*$'; then
      count=$(printf '%s' "$identity_json" | grep -o '"agent_id"' | wc -l)
      if test "$count" -eq 1; then
        candidate=$(printf '%s' "$identity_json" | sed -n 's/.*"agent_id"[ ]*:[ ]*"\\([A-Za-z0-9._:-]*\\)".*/\\1/p')
        if test -n "$candidate" && test "\${#candidate}" -le 256; then agent_id=$candidate; identity_state=valid; fi
      fi
    fi
  fi
fi
paths_safe=1
(lm_assert_paths) >/dev/null 2>&1 || paths_safe=0
operation_lock=0
(lm_assert_no_operations) >/dev/null 2>&1 || operation_lock=1
program_evidence=
for path in /etc/systemd/system/lightmoni-agent.service /usr/local/bin/lightmoni-agent /opt/lightmoni-agent /usr/local/sbin/lightmoni-agent-uninstall; do
  state=absent
  if test -L "$path"; then state=symlink
  elif test -f "$path" && test -r "$path"; then state=$(sha256sum "$path") || exit 42; state=\${state%% *}
  elif test -d "$path"; then state=directory
  elif test -e "$path"; then state=other; fi
  program_evidence="$program_evidence:$state"
done
if test -d /opt/lightmoni-agent && ! test -L /opt/lightmoni-agent; then
  root_metadata=$(stat -c '%d:%i:%Y' -- /opt/lightmoni-agent) || exit 42
  program_evidence="$program_evidence:$root_metadata"
fi
if test -L /opt/lightmoni-agent/current; then
  current_target=$(readlink /opt/lightmoni-agent/current) || exit 42
  program_evidence="$program_evidence:$current_target"
  current_name=\${current_target#/opt/lightmoni-agent/releases/}
  case "$current_target" in /opt/lightmoni-agent/releases/*) ;; *) paths_safe=0;; esac
  case "$current_name" in ''|.|..|*[!A-Za-z0-9._-]*) paths_safe=0;; esac
  if test "$paths_safe" = 1; then
    (lm_root_entry /opt/lightmoni-agent/releases directory; lm_root_entry "$current_target" directory) >/dev/null 2>&1 || paths_safe=0
    for metadata in release.json installation.json; do
      file="$current_target/$metadata"
      if test -e "$file" || test -L "$file"; then
        if ! (lm_root_entry "$file" file) >/dev/null 2>&1 || ! test -f "$file" || test "$(wc -c < "$file")" -gt 16384; then paths_safe=0
        else digest=$(sha256sum "$file") || exit 42; program_evidence="$program_evidence:\${digest%% *}"; fi
      else program_evidence="$program_evidence:missing"; fi
    done
  fi
elif test -e /opt/lightmoni-agent/current; then
  paths_safe=0
fi
program_sha256=$(printf '%s' "$program_evidence" | sha256sum)
program_sha256=\${program_sha256%% *}
printf 'LMREMOVE=1\\nagent_id=%s\\nidentity_state=%s\\nidentity_sha256=%s\\nprogram_sha256=%s\\n' "$agent_id" "$identity_state" "$identity_sha256" "$program_sha256"
if test -e /usr/local/bin/lightmoni-agent || test -L /usr/local/bin/lightmoni-agent || test -e /opt/lightmoni-agent || test -e /etc/systemd/system/lightmoni-agent.service || test -e /usr/local/sbin/lightmoni-agent-uninstall; then echo installation=present; else echo installation=absent; fi
if test -f /usr/local/bin/lightmoni-agent && test -d /opt/lightmoni-agent && test -f /etc/systemd/system/lightmoni-agent.service; then echo program_complete=1; else echo program_complete=0; fi
service_state=$(systemctl show lightmoni-agent.service --property=ActiveState --value)
fragment=$(systemctl show lightmoni-agent.service --property=FragmentPath --value)
load_state=$(systemctl show lightmoni-agent.service --property=LoadState --value)
case "$fragment:$load_state" in /etc/systemd/system/lightmoni-agent.service:loaded|:not-found) echo unit_managed=1;; *) echo unit_managed=0;; esac
case "$service_state" in active) echo service_running=1;; inactive|failed) echo service_running=0;; *) exit 42;; esac
if test -e /run/lightmoni-agent-lifecycle.lock || test -L /run/lightmoni-agent-lifecycle.lock; then echo lifecycle_locked=1; else echo lifecycle_locked=0; fi
printf 'operation_lock=%s\\npaths_safe=%s\\n' "$operation_lock" "$paths_safe"
if test -d /etc/lightmoni-agent && ! test -L /etc/lightmoni-agent; then echo config_present=1; else echo config_present=0; fi
if test -d /var/lib/lightmoni-agent && ! test -L /var/lib/lightmoni-agent; then echo data_present=1; else echo data_present=0; fi`;

export const agentRemovalProbeCommand = () => privileged(`set -eu\n# LMAGENT removal observation\n${agentMaintenanceShellGuards}\n${removalObservation}`);
export function parseAgentRemovalProbe(output: string): AgentRemovalObservation {
  if (Buffer.byteLength(output)>8192) throw new SSHError("invalid_response");
  const pairs=output.trim().split(/\r?\n/).map(line=>/^([a-z_0-9]+|LMREMOVE)=([A-Za-z0-9._:-]+)$/.exec(line));
  if(pairs.length!==14 || pairs.some(pair=>!pair)) throw new SSHError("invalid_response");
  const v=new Map(pairs.map(pair=>[pair![1],pair![2]]));
  const bools=["program_complete","unit_managed","service_running","lifecycle_locked","operation_lock","paths_safe","config_present","data_present"];
  if(v.size!==14 || v.get("LMREMOVE")!=="1" || !["valid","missing","invalid","unsafe"].includes(v.get("identity_state")||"")
    || !["present","absent"].includes(v.get("installation")||"") || bools.some(key=>!["0","1"].includes(v.get(key)||""))
    || !/^[a-f0-9]{64}$/.test(v.get("program_sha256")||"") || !/^(?:-|[a-f0-9]{64})$/.test(v.get("identity_sha256")||"")) throw new SSHError("invalid_response");
  const valid=v.get("identity_state")==="valid",agentID=v.get("agent_id")||"";
  if(valid ? !/^[A-Za-z0-9._:-]{1,256}$/.test(agentID) || !/^[a-f0-9]{64}$/.test(v.get("identity_sha256")||"") : agentID!=="-") throw new SSHError("invalid_response");
  return {agent_id:valid?agentID:"",identity_state:v.get("identity_state") as AgentRemovalObservation["identity_state"],identity_sha256:v.get("identity_sha256")!,program_sha256:v.get("program_sha256")!,installation:v.get("installation") as "present"|"absent",
    program_complete:v.get("program_complete")==="1",unit_managed:v.get("unit_managed")==="1",service_running:v.get("service_running")==="1",lifecycle_locked:v.get("lifecycle_locked")==="1",operation_lock:v.get("operation_lock")==="1",paths_safe:v.get("paths_safe")==="1",config_present:v.get("config_present")==="1",data_present:v.get("data_present")==="1"};
}
export function removalSnapshot(value: AgentRemovalObservation) {
  const {lifecycle_locked,operation_lock,...snapshot}=value;
  return snapshot;
}
export function agentRemovalCommand(expected: AgentRemovalObservation, purge=false) {
  const checks=Object.entries(removalSnapshot(expected)).map(([key,value])=>[key,typeof value==="boolean"?(value?"1":"0"):value || "-"] as const);
  const script=`set -eu
umask 077
${agentMaintenanceShellGuards}
if [ -e /etc/lightmoni-executor ] || [ -L /etc/lightmoni-executor ] || [ -e /opt/lightmoni-executor ] || [ -L /opt/lightmoni-executor ]; then lm_refuse 'Remove the privileged executor before removing the ordinary Agent'; fi
lm_assert_paths
lm_assert_no_operations
lock=/run/lightmoni-agent-lifecycle.lock
mkdir "$lock" || exit 42
trap 'rmdir "$lock"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
snapshot() {
${removalObservation}
}
observed=$(snapshot)
${checks.map(([key,value])=>`test "$(printf '%s\\n' "$observed" | sed -n 's/^${key}=//p')" = ${quote(value)} || { echo 'Approved Agent evidence changed; no files removed.' >&2; exit 42; }`).join("\n")}
lm_assert_paths
lm_assert_no_operations
fragment=$(systemctl show lightmoni-agent.service --property=FragmentPath --value)
load_state=$(systemctl show lightmoni-agent.service --property=LoadState --value)
case "$fragment:$load_state" in /etc/systemd/system/lightmoni-agent.service:loaded) systemctl stop lightmoni-agent.service;; :not-found) ;; *) exit 42;; esac
service_state=$(systemctl show lightmoni-agent.service --property=ActiveState --value)
case "$service_state" in inactive|failed) ;; *) exit 42;; esac
lm_assert_paths
lm_assert_no_operations
if test "$load_state" = loaded; then systemctl disable lightmoni-agent.service; fi
rm -f /etc/systemd/system/lightmoni-agent.service /usr/local/bin/lightmoni-agent /usr/local/sbin/lightmoni-agent-uninstall
rm -rf /opt/lightmoni-agent
systemctl daemon-reload
test "$(systemctl show lightmoni-agent.service --property=LoadState --value)" = not-found || exit 42
${purge?"lm_assert_paths\nlm_assert_no_operations\nrm -rf /etc/lightmoni-agent /var/lib/lightmoni-agent":""}
rmdir "$lock"
trap - EXIT HUP INT TERM
${removalObservation}`;
  return privileged(script);
}
