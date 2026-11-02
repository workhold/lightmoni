import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
// This public, root-owned module is shipped beside both the installer and
// maintenance helpers. Only these exact units are accepted for maintenance.
export const USER_SERVICE = `[Unit]
Description=LightMoni Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=lightmoni-agent
Group=lightmoni-agent
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
SupplementaryGroups=
AmbientCapabilities=
CapabilityBoundingSet=
ExecStartPre=/opt/lightmoni-agent/current/node /opt/lightmoni-agent/current/deployment-permissions.mjs check
RuntimeDirectory=lightmoni-agent
RuntimeDirectoryMode=0700
ExecStart=/usr/bin/flock --no-fork --exclusive --nonblock /run/lightmoni-agent/runner.lock /usr/local/bin/lightmoni-agent run --config /etc/lightmoni-agent/config.json
Restart=on-failure
RestartSec=5s
TimeoutStopSec=15s
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
PrivateTmp=true
ReadWritePaths=/var/lib/lightmoni-agent
UMask=0077

[Install]
WantedBy=multi-user.target
`;
export const ROOT_SERVICE = USER_SERVICE.replace(
  "User=lightmoni-agent",
  "User=root",
)
  .replace("Group=lightmoni-agent", "Group=root")
  .replace("CapabilityBoundingSet=\n", "")
  .replace("ProtectSystem=strict\n", "")
  .replace("ProtectHome=read-only\n", "")
  .replace("PrivateTmp=true\n", "")
  .replace("ReadWritePaths=/var/lib/lightmoni-agent\n", "");
export const serviceHash = (value) =>
  createHash("sha256").update(value).digest("hex");
export const USER_SERVICE_SHA256 = serviceHash(USER_SERVICE);
export const ROOT_SERVICE_SHA256 = serviceHash(ROOT_SERVICE);
export function buildAgentService(mode) {
  if (mode !== "root" && mode !== "user") throw Error("invalid_runtime_mode");
  return mode === "root" ? ROOT_SERVICE : USER_SERVICE;
}
export function identifyAgentService(value) {
  const hash = serviceHash(value);
  if (hash === USER_SERVICE_SHA256) return "user";
  if (hash === ROOT_SERVICE_SHA256) return "root";
  throw Error("agent_service_override_not_allowed");
}
if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.argv[2] === "render")
    process.stdout.write(buildAgentService(process.argv[3]));
  else if (process.argv[2] === "check")
    process.stdout.write(
      identifyAgentService(readFileSync(process.argv[3])) + "\n",
    );
  else throw Error("invalid_service_command");
}
