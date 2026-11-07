import { STANDARD_PLATFORM_ROOT } from '../operations/storage.js';
import { fail } from '../shared/http.js';
import type { PlatformStore } from './types.js';
type Row = Record<string, any>;

/** Only explicit non-secret metadata is exposed, even if an old Agent returned
 * extra fields. Paths are observations, never input to a filesystem operation. */
function publicStorage(value: Row | undefined, websiteID?: string) {
  if (value?.layout_version !== 1) return null;
  const string = (v: unknown) => typeof v === 'string' ? v.slice(0, 1024) : null;
  const out: Row = { layout_version: 1 };
  for (const key of ['instance_root','state_file','current','config_file','version_root']) out[key] = string(value[key]);
  out.mounts = websiteID ? [] : (Array.isArray(value.mounts) ? value.mounts : []).filter((m: unknown) => m && typeof m === 'object').slice(0, 128).map((m: Row) => ({
    container_id: string(m.container_id), service: string(m.service), type: string(m.type),
    source: string(m.source), target: string(m.target), volume: string(m.volume), read_only: m.read_only === true,
  }));
  out.sites = (Array.isArray(value.sites) ? value.sites : []).filter((s: Row) => s && typeof s === 'object' && (!websiteID || s.website_id === websiteID)).slice(0, 100).map((s: Row) => ({
    website_id: string(s.website_id), fragment_id: string(s.fragment_id), root: string(s.root),
    public_dir: string(s.public_dir), certificate_dir: string(s.certificate_dir),
  }));
  out.mounts_truncated = value.mounts_truncated === true;
  out.sites_truncated = value.sites_truncated === true;
  return out;
}

export function resourceStorage(store: PlatformStore, resourceID: string, offset = 0) {
  if (!Number.isSafeInteger(offset) || offset < 0) fail(400, 'invalid_storage_cursor');
  const resource = store.get(resourceID), db = store.deps.db;
  if (!['application','website'].includes(resource.kind)) fail(400, 'storage_resource_kind_required');
  let instances: Row[];
  if (resource.kind === 'application') instances = db.all<Row>('SELECT * FROM ops_cluster_instances WHERE owner_id=? ORDER BY cluster_id,machine_id,id LIMIT 21 OFFSET ?', resource.id, offset);
  else {
    const clusters = [...new Set([...(resource.spec.cluster_ids ?? []), ...db.all<Row>('SELECT cluster_id FROM ops_platform_website_deployments WHERE website_id=?', resource.id).map(d => d.cluster_id)])];
    instances = clusters.length ? db.all<Row>(`SELECT i.* FROM ops_cluster_instances i JOIN ops_platform_application_deployments d ON d.application_id=i.owner_id AND d.cluster_id=i.cluster_id
      WHERE d.role='openresty' AND i.cluster_id IN (${clusters.map(() => '?').join(',')}) ORDER BY i.cluster_id,i.machine_id,i.id LIMIT 21 OFFSET ?`, ...clusters, offset) : [];
  }
  const next = instances.length > 20 ? offset + 20 : null;
  return { resource_id: resource.id, layout_version: 1, standard_root: STANDARD_PLATFORM_ROOT, next_offset: next,
    instances: instances.slice(0, 20).map(i => {
      const observation = JSON.parse(i.observed_json || '{}');
      const storage = publicStorage(observation.storage, resource.kind === 'website' ? resource.id : undefined);
      return { instance_id: i.id, cluster_id: i.cluster_id, machine_id: i.machine_id, agent_id: i.agent_id,
        state: i.state, retired: !!i.retired, observed_at: storage ? i.last_seen : null, storage };
    }) };
}
