import { createHash } from "node:crypto";
import ssh2, { type Algorithms } from "ssh2";
const { utils } = ssh2;
import type { DB } from "../shared/types.js";

export interface HostKeyTarget {
  id: string; name: string; address: string; port: number; username: string; connection_method: string;
  host_key_fingerprint: string; host_key_public_key?: string; host_key_observed_at?: string; ssh_target_generation?: number;
}

/** Public SSH wire data only; never accepts or returns an authentication key. */
export function sshHostIdentity(key: Buffer) {
  if (!Buffer.isBuffer(key) || key.length < 8 || key.length > 16_384) throw Error("invalid SSH host key");
  const size = key.readUInt32BE(0);
  if (!size || size > 128 || size + 4 >= key.length) throw Error("invalid SSH host key");
  const type = key.subarray(4, size + 4).toString("ascii");
  if (!/^(?:ssh-(?:rsa|ed25519)|ecdsa-sha2-nistp(?:256|384|521))$/.test(type)) throw Error("unsupported SSH host key");
  const publicKey = `${type} ${key.toString("base64")}`;
  const parsed = utils.parseKey(publicKey);
  if (parsed instanceof Error || Array.isArray(parsed) || !parsed.getPublicSSH().equals(key)) throw Error("invalid SSH host key");
  return { publicKey, fingerprint: "SHA256:" + createHash("sha256").update(key).digest("base64").replace(/=+$/, "") };
}

/** Keep command and terminal connections on the already recorded host key type. */
export function hostKeyAlgorithms(machine: { host_key_public_key?: string }): Algorithms | undefined {
  const type = machine.host_key_public_key?.split(" ", 1)[0];
  if (!type) return undefined;
  const serverHostKey = type === "ssh-rsa" ? ["rsa-sha2-512", "rsa-sha2-256", "ssh-rsa"] : [type];
  return { serverHostKey: serverHostKey as Algorithms["serverHostKey"] };
}

/**
 * Pin the key from this handshake before SSH sends authentication material.
 * BEGIN IMMEDIATE plus compare-and-set binds one identity to the current target,
 * including when separate platform processes attempt the first connection.
 */
export function recordMachineHostKey(db: DB, expected: HostKeyTarget, key: Buffer, at: string, authorized: () => boolean = () => true): boolean {
  let identity: ReturnType<typeof sshHostIdentity>;
  try { identity = sshHostIdentity(key); } catch { return false; }
  let recorded: { host_key_fingerprint: string; host_key_public_key: string; host_key_observed_at: string } | undefined;
  const accepted = db.transaction(() => {
    if (!authorized()) return false;
    const current = db.get<HostKeyTarget>("SELECT * FROM managed_machines WHERE id=?", expected.id);
    if (!current || ["address", "port", "username", "connection_method"].some(field => current[field as keyof HostKeyTarget] !== expected[field as keyof HostKeyTarget])) return false;
    if (Number(current.ssh_target_generation || 0) !== Number(expected.ssh_target_generation || 0)) return false;
    if (expected.host_key_fingerprint && expected.host_key_fingerprint !== identity.fingerprint) return false;
    if (current.host_key_fingerprint && current.host_key_fingerprint !== identity.fingerprint) return false;
    if (current.host_key_public_key && current.host_key_public_key !== identity.publicKey) return false;
    if (!current.host_key_fingerprint || !current.host_key_public_key) {
      const changed = db.run(`UPDATE managed_machines SET host_key_fingerprint=?,host_key_public_key=?,host_key_observed_at=?,updated_at=?
        WHERE id=? AND address=? AND port=? AND username=? AND connection_method=? AND host_key_fingerprint=? AND ssh_target_generation=?`,
        identity.fingerprint, identity.publicKey, current.host_key_observed_at || at, at,
        expected.id, expected.address, expected.port, expected.username, expected.connection_method, current.host_key_fingerprint, Number(current.ssh_target_generation || 0));
      if (!changed.changes) return false;
    }
    recorded = { host_key_fingerprint: identity.fingerprint, host_key_public_key: identity.publicKey, host_key_observed_at: current.host_key_observed_at || at };
    return true;
  });
  if (accepted) Object.assign(expected, recorded);
  return accepted;
}
