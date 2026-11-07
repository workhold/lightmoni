import { join } from 'node:path';
import { safeID, hash } from './website-files.js';
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

/** Business storage belongs to stable application and instance IDs,
 * independently of display names and Agent installation identity. */
export function instanceStoragePaths(platformRoot: string, family: 'workloads'|'gateways', id: string, applicationID = id) {
  const root = family === 'workloads'
    ? join(platformRoot, 'applications', safeID(applicationID), 'instances', safeID(id))
    : join(platformRoot, family, safeID(id));
  return { ...(family === 'workloads' ? { application_root: join(platformRoot, 'applications', safeID(applicationID)) } : {}), instance_root: root, state_file: join(root, 'state.json') };
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

export function websiteGroups(config: any): Map<string, any[]> {
  const groups = new Map<string, any[]>();
  for (const site of config.sites ?? []) {
    const id = safeID(site.website_id ?? site.id);
    groups.set(id, [...(groups.get(id) ?? []), site]);
  }
  return groups;
}
export function websiteDigest(config: any, sites: any[]): string {
  return hash(JSON.stringify({http_port:config.http_port ?? 80,https_port:config.https_port ?? 443,sites}));
}
export function websiteStoragePaths(platformRoot: string, websiteID: string, digest?: string) {
  const root = join(platformRoot, 'websites', safeID(websiteID));
  if (digest !== undefined && !/^[a-f0-9]{64}$/.test(digest)) throw Error('INVALID_WEBSITE_VERSION');
  return { website_id: websiteID, root, current: join(root, 'current'),
    version_root: digest ? join(root, 'versions', digest) : null,
    config_file: digest ? join(root, 'versions', digest, 'nginx.conf') : null };
}
export function gatewayStorage(platformRoot: string, id: string, state: any, containers: any[]) {
  const paths = instanceStoragePaths(platformRoot, 'gateways', id);
  const sites: Record<string, unknown>[] = [];
  let bytes = 0;
  for (const [websiteID,digest] of Object.entries<string>({...state?.retained_website_versions,...state?.website_versions})) {
    const row = {...websiteStoragePaths(platformRoot, websiteID, digest), active:!!state?.website_versions?.[websiteID],
      public_dir: join(platformRoot,'websites',websiteID,'versions',digest,'public'),
      certificate_dir: join(platformRoot,'websites',websiteID,'versions',digest,'ssl'),
      auth_dir: join(platformRoot,'websites',websiteID,'versions',digest,'auth')};
    bytes += Buffer.byteLength(JSON.stringify(row));
    if (sites.length >= 100 || bytes > 8192) break;
    sites.push(row);
  }
  const version = state?.digest && /^[a-f0-9]{64}$/.test(state.digest) ? join(paths.instance_root,'versions',state.digest) : null;
  return { layout_version: 2, ...paths, current: version ? join(paths.instance_root,'current') : null,
    config_file: version ? join(paths.instance_root,'current','nginx.conf') : null, version_root: version,
    ...observedMounts(containers), sites, sites_truncated:Object.keys({...state?.retained_website_versions,...state?.website_versions}).length > sites.length };
}
