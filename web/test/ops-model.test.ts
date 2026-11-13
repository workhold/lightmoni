import test from 'node:test';
import assert from 'node:assert/strict';
import {resourceState, type Resource} from '../src/app/ops/model.js';

const application = (instance?: Record<string, unknown>): Resource => ({
  id: 'app', kind: 'application', name: 'App', revision: 2,
  created_at: '', updated_at: '',
  spec: {deployment_mode: 'manual', deployments: [{cluster_id: 'cluster'}]},
  status: {
    deployments: {cluster: {enabled: true, desired_revision: 2, applied_revision: 2}},
    instances: instance ? [{id: 'instance', state: 'running', healthy: true, ...instance}] : [],
  },
});

test('application state distinguishes verified running, stale observation, and initial deployment', () => {
  assert.equal(resourceState(application({availability: 'ready'})), 'running');
  assert.equal(resourceState(application({availability: 'retained'})), 'unverified');
  assert.equal(resourceState(application({availability: 'grace'})), 'unverified');
  assert.equal(resourceState(application({availability: 'unavailable', healthy: false})), 'unverified');
  assert.equal(resourceState(application({availability: 'ready', recovery: {state: 'blocked', code: 'unknown_execution_result'}})), 'unverified');
  assert.equal(resourceState(application()), 'pending');
  assert.equal(resourceState(application({state: 'unknown'})), 'unknown');
});
