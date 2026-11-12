/** The first production release with all three fixed SSH entrypoints predates
 * explicit heartbeat evidence. Keep this exact revision as a migration bridge. */
export const VERIFIED_SSH_ONCE_REVISION = '16b151337cc94c1b7f3f7de56bdcad561759c85b';

export type SSHOnceCommand = 'managed-once' | 'jobs-once' | 'task-once';
const COMMANDS: readonly SSHOnceCommand[] = ['managed-once', 'jobs-once', 'task-once'];

export function validateSSHOnceCommands(value: unknown, allowed: readonly SSHOnceCommand[]): SSHOnceCommand[] {
  if (!Array.isArray(value) || value.length > allowed.length || value.some(item => typeof item !== 'string' || !allowed.includes(item as SSHOnceCommand))
    || new Set(value).size !== value.length) throw Error('invalid_ssh_once_commands');
  return value as SSHOnceCommand[];
}

/** The observation must already have come from the authenticated, bound
 * Agent or signed helper. A missing/invalid release is never readiness proof. */
export function supportsSSHOnce(observation: unknown, command: SSHOnceCommand): boolean {
  if (!observation || typeof observation !== 'object') return false;
  const value = observation as Record<string, unknown>;
  const release = value.release;
  if (!release || typeof release !== 'object') return false;
  const identity = release as Record<string, unknown>;
  if (identity.state_schema !== 1 || typeof identity.source_revision !== 'string' || !/^[a-f0-9]{40}$/.test(identity.source_revision)) return false;
  if (value.ssh_once_commands === undefined) return identity.source_revision === VERIFIED_SSH_ONCE_REVISION;
  try { return validateSSHOnceCommands(value.ssh_once_commands, COMMANDS).includes(command); }
  catch { return false; }
}
