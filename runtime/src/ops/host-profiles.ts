import { fail } from '../shared/http.js';
import type { PlatformResource, ResourceKind } from './types.js';

const hostActions: Partial<Record<ResourceKind, readonly string[]>> = {
  cluster: ['inspect'],
  node_pool: ['inspect'],
  application: ['deploy', 'inspect', 'stop', 'remove', 'logs', 'reconcile'],
  service: ['deploy', 'reconcile', 'inspect', 'stop'],
  gateway_group: ['deploy', 'inspect', 'stop'],
  website: ['deploy', 'disable'],
};
/** Host operations need their own typed executor profile; cloud and stored-state reads remain available. */
export function assertImplementedHostProfile(resource: Pick<PlatformResource, 'kind' | 'spec'>, action: string): void {
  if (hostActions[resource.kind]?.includes(action)
    || resource.kind === 'certificate_target' && resource.spec.type !== 'cloud' && ['sync', 'inspect', 'retry'].includes(action))
    fail(409, 'privileged_profile_not_implemented');
}
