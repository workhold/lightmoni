import test from 'node:test';
import assert from 'node:assert/strict';
import {filterApplicationsByState, resourceState, type Resource} from '../src/app/ops/model.js';
import {installationState} from '../src/app/ops/install-state.js';

const instance = (overrides: Record<string, unknown> = {}) => ({
  id: 'instance-a', cluster_id: 'cluster', machine_id: 'machine-a', slot: '0', state: 'running',
  healthy: true, availability: 'ready', observed_generation: '2', ...overrides,
});

const application = (overrides: Partial<Resource> = {}): Resource => ({
  id: 'app', kind: 'application', name: 'App', revision: 2,
  created_at: '', updated_at: '',
  spec: {deployment_mode: 'manual', deployments: [{cluster_id: 'cluster', machine_ids: ['machine-a']}]},
  status: {
    deployments: {cluster: {enabled: true, desired_revision: 2, applied_revision: 2, instances_total: 1, ready_instances: 1}},
    instances: [instance()],
  },
  ...overrides,
});

test('only a complete, current and observed deployment is running', () => {
  assert.equal(resourceState(application()), 'running');
  for (const availability of ['retained', 'grace', 'protected']) {
    assert.equal(resourceState(application({status: {...application().status, instances: [instance({availability})]}})), 'unverified');
  }
  assert.equal(resourceState(application({status: {...application().status, instances: [instance({availability: 'unavailable', healthy: false})]}})), 'unverified');
  assert.equal(resourceState(application({status: {...application().status, instances: [instance({recovery: {state: 'blocked', code: 'unknown_execution_result'}})]}})), 'unverified');
  assert.equal(resourceState(application({status: {...application().status, instances_truncated: true}})), 'unverified');
  assert.equal(resourceState(application({status: {...application().status, instances: []}})), 'pending');
});

test('unknown and explicit failure outrank retained availability', () => {
  assert.equal(resourceState(application({status: {...application().status, instances: [instance({state: 'unknown', availability: 'retained'})]}})), 'unknown');
  assert.equal(resourceState(application({status: {...application().status, instances: [instance({unresolved_run_id: 'run-unknown'})]}})), 'unknown');
  assert.equal(resourceState(application({status: {...application().status, instances: [instance({state: 'failed', availability: 'retained'})]}})), 'failed');
  assert.equal(resourceState(application({status: {...application().status, deployments: {cluster: {...application().status.deployments.cluster, last_error: 'deploy_failed'}}, instances: [instance({availability: 'retained'})]}})), 'failed');
});

test('a single healthy replica cannot verify a two-replica deployment', () => {
  const app = application({spec: {deployment_mode: 'managed', deployments: [{cluster_id: 'cluster', replicas: 2}]}});
  assert.equal(resourceState(app), 'pending');
  assert.equal(resourceState(application({spec: app.spec, status: {...app.status, deployments: {cluster: {...app.status.deployments.cluster, instances_total: 2, ready_instances: 2}}, instances: [instance(), instance({id: 'instance-b', machine_id: 'machine-b', slot: '1'})]}})), 'running');
});

test('managed scale-down accepts stopped surplus rows but not running surplus', () => {
  const app = application({
    spec: {deployment_mode: 'managed', deployments: [{cluster_id: 'cluster', replicas: 1}]},
    status: {
      deployments: {cluster: {enabled: true, desired_revision: 2, applied_revision: 2, instances_total: 2, ready_instances: 1}},
      instances: [instance(), instance({id: 'instance-b', machine_id: 'machine-b', slot: '1', state: 'stopped', healthy: false, availability: 'unavailable'})],
    },
  });
  assert.equal(resourceState(app), 'running');
  assert.notEqual(resourceState(application({spec: app.spec, status: {...app.status, instances: [instance(), instance({id: 'instance-b', machine_id: 'machine-b', slot: '1'})]}})), 'running');
});

test('a stopped zero-replica cluster can coexist with a ready cluster', () => {
  const app = application({
    spec: {deployment_mode: 'managed', deployments: [{cluster_id: 'cluster', replicas: 0}, {cluster_id: 'other', replicas: 1}]},
    status: {
      deployments: {
        cluster: {enabled: true, desired_revision: 2, applied_revision: 2, instances_total: 1, ready_instances: 0},
        other: {enabled: true, desired_revision: 2, applied_revision: 2, instances_total: 1, ready_instances: 1},
      },
      instances: [instance({state: 'stopped', healthy: false, availability: 'unavailable'}), instance({id: 'instance-b', cluster_id: 'other', machine_id: 'machine-b'})],
    },
  });
  assert.equal(resourceState(app), 'running');
  assert.notEqual(resourceState(application({spec: app.spec, status: {...app.status, instances: [instance(), app.status.instances[1]]}})), 'running');
});

test('disabled cluster leftovers do not override the published cluster', () => {
  const app = application();
  assert.equal(resourceState(application({status: {...app.status, deployments: {...app.status.deployments, old: {enabled: false, desired_revision: 1, last_error: 'old_error'}}, instances: [...app.status.instances, instance({id: 'old', cluster_id: 'old', state: 'unknown'})]}})), 'running');
});

test('disabled deployment intent does not claim a stale healthy instance is running', () => {
  const app = application();
  const stopped = application({status: {...app.status, deployments: {cluster: {...app.status.deployments.cluster, enabled: false}}}});
  assert.equal(resourceState(stopped), 'unverified');
  assert.equal(installationState(stopped), 'unverified');
  assert.equal(resourceState(application({status: {instances: [instance()]}})), 'unverified');
  const confirmed = application({status: {...stopped.status, instances: [instance({state: 'stopped', healthy: false, availability: 'unavailable'})]}});
  assert.equal(resourceState(confirmed), 'stopped');
  assert.equal(installationState(confirmed), 'stopped');
  const oldUnknown = application({status: {...stopped.status, instances: [instance({state: 'unknown'})]}});
  assert.equal(resourceState(oldUnknown), 'unverified');
  assert.equal(installationState(oldUnknown), 'unknown');
});

test('retired unresolved history does not replace current deployment state', () => {
  const app = application();
  const retired = application({status: {...app.status, instances: [...app.status.instances, instance({id: 'retired', retired: true, unresolved_run_id: 'old-run'})]}});
  assert.equal(resourceState(retired), 'running');
  assert.equal(installationState(retired), 'succeeded');
});

test('saved configuration and published revision remain distinct', () => {
  const app = application();
  assert.equal(resourceState(application({revision: 3, status: app.status})), 'unverified');
  const zero = application({spec: {deployment_mode: 'managed', deployments: [{cluster_id: 'cluster', replicas: 0}]}, status: {...app.status, instances: []}});
  assert.equal(resourceState(zero), 'stopped');
  assert.equal(resourceState(application({spec: zero.spec, status: {...zero.status, instances: [instance({state: 'stopped', healthy: false, availability: 'unavailable'})]}})), 'stopped');
  assert.notEqual(resourceState(application({spec: zero.spec, status: {...zero.status, instances: [instance()]}})), 'stopped');
  assert.equal(resourceState(application({revision: 3, spec: zero.spec, status: zero.status})), 'unverified');
});

test('state filters have exclusive pending and unverified groups', () => {
  const base = application();
  const apps = [
    base,
    application({id: 'pending', status: {...base.status, instances: []}}),
    application({id: 'unverified', status: {...base.status, instances: [instance({availability: 'retained'})]}}),
    application({id: 'failed', status: {...base.status, instances: [instance({state: 'failed'})]}}),
    application({id: 'unknown', status: {...base.status, instances: [instance({state: 'unknown'})]}}),
  ];
  assert.deepEqual(filterApplicationsByState(apps, 'running').map(app => app.id), ['app']);
  assert.deepEqual(filterApplicationsByState(apps, 'pending').map(app => app.id), ['pending']);
  assert.deepEqual(filterApplicationsByState(apps, 'unverified').map(app => app.id), ['unverified']);
  assert.deepEqual(filterApplicationsByState(apps, 'failed').map(app => app.id), ['failed', 'unknown']);
});

test('installation summary follows observed state and retains historical unknown execution', () => {
  const app = application();
  assert.equal(installationState(app), 'succeeded');
  assert.equal(installationState(application({status: {...app.status, instances: [instance({availability: 'retained', healthy: false})]}})), 'unverified');
  assert.equal(installationState(application({status: {...app.status, instances: [instance({recovery: {state: 'blocked', code: 'unknown_execution_result'}})]}})), 'unverified');
  assert.equal(installationState(application({spec: {deployment_mode: 'managed', deployments: [{cluster_id: 'cluster', replicas: 2}]}})), 'pending');
  const historical = application({status: {...app.status, deployments: {...app.status.deployments, old: {enabled: false, desired_revision: 1}}, instances: [...app.status.instances, instance({id: 'old', cluster_id: 'old', state: 'unknown', desired_state: 'removed'})]}});
  assert.equal(resourceState(historical), 'running');
  assert.equal(installationState(historical), 'unknown');
});
