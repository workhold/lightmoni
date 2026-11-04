import { applicationCatalog } from './catalog.js';
import { systemApplicationKind } from './system-applications.js';
import { cleanResult, safeObject, type OperationsPlatformStore } from './store.js';
import { fail } from '../shared/http.js';
import type { DomainController, PlatformResource } from './types.js';
import type { Handler } from '../shared/types.js';
import { blockingAgentJobSQL } from '../server/agent-job-fence.js';
import { operationExecutionCapabilities } from '../server/managed-executor-status.js';
import { hash } from '../shared/crypto.js';

export function applicationImages(spec: Record<string, any>): Record<string, string> {
  return spec.mode === 'container' ? {app: spec.image} : Object.fromEntries(
    Object.entries<any>(spec.compose?.services ?? {}).map(([name, service]) => [name, service.image]),
  );
}
export function applicationUpgrade(resource: PlatformResource) {
  const source = resource.spec.source?.type ?? 'custom', current = applicationImages(resource.spec);
  const template = source === 'store' ? applicationCatalog.find(t => t.id === resource.spec.source.template_id) : undefined;
  const target = template ? applicationImages(template.spec) : current;
  const topology = template && (template.spec.mode !== resource.spec.mode ||
    JSON.stringify(Object.keys(current).sort()) !== JSON.stringify(Object.keys(target).sort()));
  const blocked = source === 'store' && !template ? 'application_template_not_found' : topology ? 'upgrade_service_topology_changed' : '';
  return {revision: resource.revision, source, current_version:resource.spec.source?.template_version ?? '',
    target_version:template?.version ?? '', current_images:current, target_images:target,
    target_fingerprint:template?hash(JSON.stringify({version:template.version,mode:template.spec.mode,images:target})):undefined,blocked_reason:blocked,
    available:source === 'store' && !blocked && (resource.spec.source.template_version !== template!.version ||
      Object.keys(current).some(key => current[key] !== target[key]))};
}
export function registerApplicationUpgrades(store: OperationsPlatformStore, workloads: DomainController, safe: (fn: Handler) => Handler) {
  const path = '/api/v1/ops/resources/:id/upgrade';
  store.deps.router.get(path, safe(ctx => ctx.json(applicationUpgrade(store.get(ctx.params.id, 'application')))));
  store.deps.router.post(path, safe(async ctx => {
    const input = safeObject(await ctx.body()), resource = store.get(ctx.params.id, 'application'), preview = applicationUpgrade(resource);
    if (Object.keys(input).some(k => !['revision','confirmed','target_version','target_fingerprint','images'].includes(k))) fail(400,'invalid_upgrade_parameter');
    if (input.confirmed !== true) fail(400,'platform_confirmation_required');
    if (input.revision !== resource.revision) fail(409,'platform_revision_conflict');
    if (preview.blocked_reason) fail(409,preview.blocked_reason);
    const targets=store.deps.db.all<{agent_id:string}>('SELECT DISTINCT agent_id FROM ops_cluster_instances WHERE owner_id=? AND retired=0 AND desired_state=\'running\'',resource.id);
    for(const target of targets)if(!operationExecutionCapabilities(store.deps,target.agent_id).includes('operations.platform.image-refresh.v1'))fail(409,'image_refresh_agent_upgrade_required');
    // A queued or unknown execution must be reconciled before authorizing a new revision.
    if (store.deps.db.get(`SELECT r.id FROM ops_platform_runs r LEFT JOIN agent_jobs j ON j.id=r.job_id WHERE r.resource_id=? AND (r.state IN ('queued','leased','accepted','preflighting','staging','activating','verifying','running') OR (r.state='unknown' AND (j.id IS NULL OR (${blockingAgentJobSQL(store.deps.db,'j')})))) LIMIT 1`,resource.id))
      fail(409,'platform_resource_busy');
    let images: Record<string, any>;
    if (preview.source === 'store') {
      if (input.images !== undefined) fail(400,'invalid_upgrade_parameter');
      if (input.target_version !== preview.target_version || input.target_fingerprint !== preview.target_fingerprint) fail(409,'application_template_changed');
      images = preview.target_images;
    } else {
      if (input.target_version !== undefined || input.target_fingerprint !== undefined) fail(400,'invalid_upgrade_parameter');
      images = safeObject(input.images);
      if (JSON.stringify(Object.keys(images).sort()) !== JSON.stringify(Object.keys(preview.current_images).sort())) fail(400,'upgrade_services_required');
    }
    if (Object.values(images).some(value => typeof value !== 'string' || !value || value.length > 512 || /[\s\x00-\x1f\x7f]/.test(value) || value.startsWith('-') || /["'`$;|&<>\\]/.test(value))) fail(400,'invalid_upgrade_image');
    const spec = structuredClone(resource.spec);
    // Parsed structured state is authoritative; a generated YAML string must not overwrite new images.
    spec.configuration_mode = 'form'; delete spec.configuration_yaml;
    spec.image_pull_policy = 'always';
    if (spec.mode === 'container') spec.image = images.app;
    else for (const [name,image] of Object.entries(images)) spec.compose.services[name].image = image;
    if (preview.source === 'store') spec.source.template_version = preview.target_version;
    const saved = systemApplicationKind(store,resource.id)
      ? store.updateSystemApplication(resource.id,resource.revision,resource.name,spec,ctx.user.id)
      : store.update(resource.id,resource.revision,resource.name,spec,ctx.user.id);
    // Desired state is durable even if dispatch fails; report that separately for a safe deploy retry.
    let result: any;
    try { result = await workloads.perform(saved,'deploy',{},ctx.user.id); }
    catch { result = {runs:[],deploy_error:'upgrade_saved_deploy_retry_required'}; }
    ctx.json({resource:store.public(store.get(saved.id)),...cleanResult(result)},202);
  }));
}
