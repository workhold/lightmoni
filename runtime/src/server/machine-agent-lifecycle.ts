import { SSHError } from "./machine-ssh.js";

const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
export const retainedAgentPaths = ["/etc/lightmoni-agent", "/var/lib/lightmoni-agent"];
export const removedAgentPaths = ["/etc/systemd/system/lightmoni-agent.service", "/usr/local/bin/lightmoni-agent", "/opt/lightmoni-agent"];
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
