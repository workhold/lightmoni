/** Only these static diagnostics may leave the command executor. Never expose stderr. */
export const installPhases: Record<string, string> = {
  queued: 'Waiting for an Agent to accept the job',
  accepted: 'Agent accepted the installation',
  staging: 'Preparing installation prerequisites',
  activating: 'Applying the approved configuration',
  checking_docker: 'Checking Docker availability',
  checking_ports: 'Checking host port availability',
  validating_config: 'Validating Docker Compose configuration',
  starting_containers: 'Pulling images and starting containers',
  checking_health: 'Checking container health and service readiness',
  validating_gateway: 'Checking the OpenResty configuration',
  starting_gateway: 'Starting or reloading OpenResty',
  restoring_previous: 'Restoring the previous deployment or cleaning up the failed installation',
  verifying: 'Recording verification evidence',
  succeeded: 'Operation completed and verified',
  failed: 'Operation failed; review the recorded cause',
  unknown: 'Result unknown; inspect the target before retrying',
  cancelled: 'Operation cancelled',
};
export const installCauses: Record<string, string> = {
  operation_failed: 'The operation failed; inspect the target and its configuration.',
  docker_prerequisite_failed: 'Docker prerequisites could not be verified.',
  compose_preflight_failed: 'Docker Compose configuration could not be validated.',
  gateway_preflight_failed: 'OpenResty configuration could not be validated.',
  workload_apply_failed_restored: 'Installation failed; restoration or cleanup was verified.',
  gateway_apply_failed_restored: 'Gateway installation failed; the previous state was restored.',
  workload_apply_recovery_failed: 'Installation recovery failed; inspect actual state before retrying.',
  gateway_apply_recovery_failed: 'Gateway recovery failed; inspect actual state before retrying.',
  unknown_execution_result: 'The result is unknown; inspect actual state before retrying.',
  operation_not_verified: 'The operation did not pass verification.',
  operation_dependency_unavailable: 'A required command is unavailable on the target.',
  operation_output_limit: 'Command output exceeded the execution limit.',
  docker_cli_missing: 'Docker CLI is not installed on the target.',
  docker_daemon_unavailable: 'Docker daemon is unavailable on the target.',
  docker_unavailable: 'Docker is unavailable or its daemon cannot be reached.',
  docker_permission_denied: 'The Agent has no permission to access Docker.',
  image_not_found: 'The image or tag could not be found in the registry.',
  image_access_denied: 'The registry denied access to the image.',
  image_network_failed: 'The registry could not be reached or the image transfer timed out.',
  host_port_occupied: 'A required host port is already occupied.',
  host_port_check_failed: 'The host port could not be checked; inspect the Agent permissions and bind address.',
  disk_full: 'The host has insufficient disk space.',
  container_unhealthy: 'A container failed its health check.',
  compose_unavailable: 'The Docker Compose plugin is unavailable.',
  operation_command_timeout: 'The command exceeded its execution timeout.',
  operation_command_failed: 'The command failed; inspect Docker and the application configuration on the target.',
  workload_health_not_verified: 'The expected containers are not running or healthy.',
  workload_readiness_not_verified: 'The service did not pass its readiness probe.',
};
export function installCause(error: unknown): string {
  const e = error as {diagnosticCode?: string; code?: string; message?: string} | undefined;
  return [e?.diagnosticCode, e?.code, e?.message?.toLowerCase()].find((code): code is string => !!code && Object.hasOwn(installCauses, code)) ?? '';
}
export function commandDiagnostic(stderr: string, docker: boolean): string {
  if (!docker) return 'operation_command_failed';
  if (/no space left|disk quota exceeded/i.test(stderr)) return 'disk_full';
  if (/permission denied.*docker|docker.*permission denied/i.test(stderr)) return 'docker_permission_denied';
  if (/cannot connect to.*docker|is the docker daemon running|error during connect/i.test(stderr)) return 'docker_unavailable';
  if (/address already in use|port is already allocated|ports are not available/i.test(stderr)) return 'host_port_occupied';
  if (/manifest unknown|manifest.*not found|no matching manifest|not found: manifest|not found.*manifest/i.test(stderr)) return 'image_not_found';
  if (/pull access denied|unauthorized|authentication required|denied: requested access/i.test(stderr)) return 'image_access_denied';
  if (/i\/o timeout|tls handshake timeout|context deadline exceeded|no such host|network is unreachable|connection refused|failed to resolve/i.test(stderr)) return 'image_network_failed';
  if (/unhealthy|dependency failed to start/i.test(stderr)) return 'container_unhealthy';
  if (/compose.*not a docker command|unknown command.*compose/i.test(stderr)) return 'compose_unavailable';
  return 'operation_command_failed';
}
