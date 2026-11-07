import { join } from 'node:path';
import { safeID } from './website-files.js';
import type { OperationExecutionResult } from './types.js';

export const MANAGED_DATA_ROOT = '/var/lib/lightmoni-managed';
export const STANDARD_PLATFORM_ROOT = MANAGED_DATA_ROOT + '/operations/platform';

/** Optional metadata must not turn an otherwise valid execution into an
 * unknown result by exceeding the existing 60 KiB receipt budget. */
export function fitStorageReceipt(result: OperationExecutionResult) {
  const data = result.data, storage = data.storage;
  if (!storage) return result;
  const oversized = () => Buffer.byteLength(JSON.stringify(data)) > 60 * 1024;
  for (const key of ['mounts', 'sites']) while (oversized() && storage[key]?.length) {
    storage[key].pop(); storage[key + '_truncated'] = true;
  }
  if (oversized()) delete data.storage;
  return result;
}

/** Preserve the deployed layout: business storage belongs to the stable instance,
 * never to the mutable display name or to the Agent installation identity. */
export function instanceStoragePaths(platformRoot: string, family: 'workloads'|'gateways', id: string) {
  const root = join(platformRoot, family, safeID(id));
  return { instance_root: root, state_file: join(root, 'state.json') };
}

/** Docker is the authority for bind sources and named-volume data roots. */
export function observedMounts(containers: any[]) {
  const mounts: Record<string, unknown>[] = [];
  let truncated = false, bytes = 0;
  for (const container of containers) for (const mount of container?.Mounts ?? []) {
    if (mounts.length >= 128 || bytes > 8192) { truncated = true; continue; }
    const value = (v: unknown) => typeof v === 'string' ? v.slice(0, 1024) : '';
    const row = { container_id: value(container.Id), service: value(container.Config?.Labels?.['com.docker.compose.service']),
      type: value(mount.Type), source: value(mount.Source), target: value(mount.Destination),
      read_only: mount.RW === false, volume: value(mount.Name) };
    bytes += Buffer.byteLength(JSON.stringify(row));
    if (bytes > 8192) { truncated = true; continue; }
    mounts.push(row);
  }
  return { mounts, mounts_truncated: truncated };
}

export function gatewayStorage(platformRoot: string, id: string, state: any, containers: any[]) {
  const paths = instanceStoragePaths(platformRoot, 'gateways', id);
  const version = typeof state?.digest === 'string' && /^[a-f0-9]{64}$/.test(state.digest)
    ? join(paths.instance_root, 'versions', state.digest) : null;
  const sites: Record<string, unknown>[] = [];
  let bytes = 0;
  if (version) for (const s of state.config?.sites ?? []) {
    const root = join(version, 'sites', safeID(s.id));
    const row = { website_id: safeID(s.website_id ?? s.id), fragment_id: s.id, root,
      public_dir: s.mode === 'static' ? join(root, 'public') : null,
      certificate_dir: s.certificate ? root : null };
    bytes += Buffer.byteLength(JSON.stringify(row));
    if (sites.length >= 100 || bytes > 8192) break;
    sites.push(row);
  }
  return { layout_version: 1, ...paths, current: version ? join(paths.instance_root, 'current') : null,
    config_file: version ? join(paths.instance_root, 'current', 'nginx.conf') : null, version_root: version,
    ...observedMounts(containers), sites, sites_truncated: (state?.config?.sites?.length ?? 0) > sites.length };
}
