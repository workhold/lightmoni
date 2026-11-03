import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The network-facing Agent always has the same unprivileged identity. Complete
// management adds a separate, root-owned helper process with its own unit.
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

export const HELPER_SERVICE = `[Unit]
Description=LightMoni Agent Privileged Helper
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
Group=root
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStartPre=/opt/lightmoni-agent/current/node /opt/lightmoni-agent/current/deployment-permissions.mjs helper-check
RuntimeDirectory=lightmoni-agent-helper
RuntimeDirectoryMode=0700
ExecStart=/usr/bin/flock --no-fork --exclusive --nonblock /run/lightmoni-agent-helper/runner.lock /usr/local/bin/lightmoni-agent helper-run
Restart=on-failure
RestartSec=5s
TimeoutStopSec=15s
NoNewPrivileges=true
ProtectHome=read-only
PrivateTmp=true
UMask=0077

[Install]
WantedBy=multi-user.target
`;

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
export const USER_SERVICE_SHA256 = sha256(USER_SERVICE);
export const HELPER_SERVICE_SHA256 = sha256(HELPER_SERVICE);
export function buildAgentService(mode) {
  if (mode !== "root" && mode !== "user") throw Error("invalid_runtime_mode");
  return USER_SERVICE;
}
export function buildHelperService() {
  return HELPER_SERVICE;
}
export function identifyAgentService(value) {
  if (sha256(value) !== USER_SERVICE_SHA256)
    throw Error("agent_service_override_not_allowed");
  return "user";
}
export function identifyHelperService(value) {
  if (sha256(value) !== HELPER_SERVICE_SHA256)
    throw Error("helper_service_override_not_allowed");
  return "root";
}
if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [command, variant, filename] = process.argv.slice(2);
  if (command === "render" && (variant === "root" || variant === "user"))
    process.stdout.write(buildAgentService(variant));
  else if (command === "render-helper")
    process.stdout.write(buildHelperService());
  else if (command === "check-agent") {
    process.stdout.write(identifyAgentService(readFileSync(variant)) + "\n");
  } else if (command === "check-helper") {
    process.stdout.write(identifyHelperService(readFileSync(variant)) + "\n");
  } else throw Error("invalid_service_command");
}
