import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MANAGED_DOCKER_SOCKET, ManagedDockerExecutor, createManagedDockerCoreForTests,
  validateManagedDockerSocketMetadata, validateManagedDockerDaemonInfo, type ManagedDockerRequest, type ManagedDockerResource,
} from '../src/privileged-executor/docker.js';

const daemon = 'local-daemon-id';
const id = 'a'.repeat(64), externalId = 'b'.repeat(64), createdId = 'c'.repeat(64);
const digest = 'sha256:' + 'd'.repeat(64), image = 'registry.example/project/app@' + digest;
const imageId = 'sha256:' + 'e'.repeat(64);
const binding: ManagedDockerResource = { daemon_id: daemon, resource_id: 'service-a', docker_id: id, revision: 7 };
const createPlan = { operation: 'create', resource_id: 'new-service', revision: 1, image, platform: 'linux/amd64', command: ['sleep', '60'] };
function hostConfig() {
  return { Privileged: false, ReadonlyRootfs: true, NetworkMode: 'none', IpcMode: 'private', PidMode: '', UTSMode: '', UsernsMode: '', CgroupnsMode: 'private', Runtime: 'runc',
    CapAdd: [], CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'], Binds: [], Mounts: [], VolumesFrom: [], Devices: [], DeviceRequests: [], PortBindings: {}, PublishAllPorts: false };
}
function container(containerId = id) {
  return { Id: containerId, Image: imageId, State: { Status: 'running' }, HostConfig: hostConfig(), Mounts: [],
    Config: { User: '65532:65532', Env: ['PASSWORD=do-not-leak'], Labels: { 'io.lightmoni.resource': 'service-a', secret: 'do-not-leak' }, Cmd: ['private-command'] },
    Name: '/do-not-leak', NetworkSettings: { private: 'do-not-leak' } };
}
function fixture() {
  const requests: ManagedDockerRequest[] = [], events: string[] = [];
  const containers = new Map([[id, container()], [externalId, container(externalId)]]);
  const imageInspect: any = { Id: imageId, Os: 'linux', Architecture: 'amd64', RepoDigests: [image], Config: {} };
  const info: any = { ID: daemon, OSType: 'linux', Architecture: 'x86_64', SecurityOptions: ['name=seccomp,profile=builtin'] };
  let nextResponse: ((request: ManagedDockerRequest) => { statusCode: number; body: unknown } | undefined) | undefined;
  const transport = async (request: ManagedDockerRequest) => {
    requests.push(request); events.push(request.method + ' ' + request.path);
    const replaced = nextResponse?.(request); if (replaced) return replaced;
    const route = request.path.replace(/^\/v1\.43/, '');
    if (route === '/info') return { statusCode: 200, body: info };
    if (route.startsWith('/images/') && route.endsWith('/json')) return { statusCode: 200, body: imageInspect };
    if (route.startsWith('/images/create?')) return { statusCode: 200, body: '{"status":"pulling"}\n{"status":"done"}\n' };
    if (route.startsWith('/containers/create?')) {
      const created: any = { ...container(createdId), State: { Status: 'created' }, Config: request.body, HostConfig: request.body!.HostConfig };
      containers.set(createdId, created);
      return { statusCode: 201, body: { Id: createdId, Warnings: [] } };
    }
    if (route.startsWith('/containers/json?')) return { statusCode: 200, body: [...containers.values()].map(row => ({ ...row, Image: 'secret-image-name', ImageID: imageId, State: row.State.Status })) };
    const match = route.match(/^\/containers\/([a-f0-9]{64})(?:\/(json|start|stop|restart))?(?:\?.*)?$/);
    if (match) {
      const row = containers.get(match[1]);
      if (!row) return { statusCode: 404, body: { message: 'do-not-leak' } };
      if (request.method === 'DELETE') { containers.delete(match[1]); return { statusCode: 204, body: '' }; }
      if (match[2] === 'json') return { statusCode: 200, body: row };
      row.State.Status = match[2] === 'stop' ? 'exited' : 'running';
      return { statusCode: 204, body: '' };
    }
    throw Error('unhandled private daemon route: ' + route);
  };
  const core = createManagedDockerCoreForTests({ daemon_id: daemon }, transport);
  const context = { resources: [binding], beforeStep: async (step: string) => { events.push('permit ' + step); } };
  return { core, context, requests, events, containers, imageInspect, info, replace: (fn: typeof nextResponse) => { nextResponse = fn; } };
}

test('strict payload rejects every raw Docker escape before accessing the daemon', async () => {
  const f = fixture();
  const dangerous = [
    { operation: 'exec', command: ['sh'] }, { operation: 'build' }, { operation: 'prune' },
    { operation: 'list', endpoint: 'tcp://attacker:2375' }, { operation: 'list', socketPath: '/tmp/docker.sock' },
    { operation: 'start', resource_id: 'service-a', revision: 7, docker_id: externalId },
    ...['HostConfig', 'host_config', 'privileged', 'devices', 'device_requests', 'cap_add', 'security_opt', 'runtime', 'userns_mode', 'pid', 'ipc', 'network_mode', 'mounts', 'volumes', 'binds', 'ports', 'driver_opts', 'VolumeOptions', 'entrypoint', 'env'].map(key => ({ ...createPlan, [key]: key })),
    ...['host', 'container:' + externalId, 'service:gateway'].map(network_mode => ({ ...createPlan, network_mode })),
    { ...createPlan, image: 'alpine:latest' }, { ...createPlan, image: 'https://user:secret@registry.example/app@' + digest },
    { ...createPlan, platform: 'linux/arm/v7' }, { ...createPlan, command: ['x\0y'] }, { ...createPlan, revision: 0 },
    { ...createPlan, name: '-unsafe' }, { ...createPlan, command: Array(33).fill('a') },
  ];
  for (const input of dangerous) await assert.rejects(f.core.execute(input, f.context), /unsafe_container_spec/);
  assert.equal(f.requests.length, 0); assert.equal(f.events.length, 0);
});

test('list and inspect external containers expose a bounded metadata allowlist, never adoption by label', async () => {
  const f = fixture();
  const result = await f.core.execute({ operation: 'list' }, f.context);
  assert.deepEqual(result.containers, [
    { docker_id: id, image_id: imageId, state: 'running', managed: true, resource_id: 'service-a', revision: 7 },
    { docker_id: externalId, image_id: imageId, state: 'running', managed: false },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /do-not-leak|secret-image|Env|Mounts|Labels|Name|NetworkSettings|Cmd/);
  const inspected = await f.core.execute({ operation: 'list', docker_id: externalId }, f.context);
  assert.equal(inspected.containers![0].managed, false);
  await assert.rejects(f.core.execute({ operation: 'remove', resource_id: externalId, revision: 7 }, f.context), /resource_not_managed/);
  assert.equal(f.requests.filter(request => request.method !== 'GET').length, 0);
  assert.equal(f.events.filter(event => event.startsWith('permit')).length, 0);
});

test('daemon identity, immutable IDs, root manifest and revision bind all state writes', async () => {
  const f = fixture();
  f.info.ID = 'replacement-daemon';
  await assert.rejects(f.core.execute({ operation: 'stop', resource_id: 'service-a', revision: 7 }, f.context), /daemon_identity_mismatch/);
  f.info.ID = daemon;
  await assert.rejects(f.core.execute({ operation: 'stop', resource_id: 'service-a', revision: 8 }, f.context), /resource_revision_mismatch/);
  await assert.rejects(f.core.execute({ operation: 'stop', resource_id: 'service-a', revision: 7 }, { ...f.context, resources: [{ ...binding, daemon_id: 'wrong' }] }), /invalid_resource_manifest/);
  await assert.rejects(f.core.execute({ operation: 'stop', resource_id: 'service-a', revision: 7 }, { ...f.context, resources: [binding, binding] }), /invalid_resource_manifest/);
  f.containers.get(id)!.Id = externalId;
  await assert.rejects(f.core.execute({ operation: 'stop', resource_id: 'service-a', revision: 7 }, f.context), /resource_identity_mismatch/);
  assert.equal(f.requests.filter(request => request.method !== 'GET').length, 0);
});

test('minimal create pins digest and architecture, enforces isolation and returns a new root manifest', async () => {
  const f = fixture(); const original = structuredClone(f.context.resources);
  const result = await f.core.execute({ ...createPlan, name: 'safe-app' }, f.context);
  assert.deepEqual(f.context.resources, original);
  assert.deepEqual(result.resources, [...original, { daemon_id: daemon, resource_id: 'new-service', docker_id: createdId, revision: 1 }]);
  assert.equal(result.resource!.docker_id, createdId); assert.equal(result.resource!.state, 'created');
  const create = f.requests.find(request => request.method === 'POST')!;
  assert.equal(create.path, '/v1.43/containers/create?platform=linux%2Famd64&name=safe-app');
  assert.equal(create.body!.Image, image); assert.equal(create.body!.User, '65532:65532');
  const host = create.body!.HostConfig as any;
  assert.equal(host.NetworkMode, 'none'); assert.equal(host.IpcMode, 'private'); assert.equal(host.ReadonlyRootfs, true); assert.equal(host.Privileged, false);
  assert.deepEqual(host.CapDrop, ['ALL']); assert.deepEqual(host.SecurityOpt, ['no-new-privileges:true']);
  for (const key of ['Binds', 'Mounts', 'Devices', 'DeviceRequests', 'VolumesFrom', 'CapAdd']) assert.deepEqual(host[key], []);
  assert.deepEqual(host.PortBindings, {}); assert.equal(host.Memory, 268435456); assert.equal(host.NanoCpus, 1000000000); assert.equal(host.PidsLimit, 64);
  assert.equal(host.LogConfig.Type, 'json-file');
  const permitIndex = f.events.indexOf('permit docker.create');
  assert(permitIndex > 0); assert.equal(f.events[permitIndex + 1], 'POST ' + create.path);
  assert.equal(f.requests.filter(request => request.path.includes('/images/create')).length, 0);
});

test('create refuses unpinned/image-volume/arch/security mismatches before requesting a mutation permit', async () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => { f.imageInspect.RepoDigests = ['different@sha256:' + 'f'.repeat(64)]; },
    (f: ReturnType<typeof fixture>) => { f.imageInspect.Architecture = 'arm64'; },
    (f: ReturnType<typeof fixture>) => { f.imageInspect.Os = 'windows'; },
    (f: ReturnType<typeof fixture>) => { f.imageInspect.Config.Volumes = { '/implicit-volume': {} }; },
    (f: ReturnType<typeof fixture>) => { f.info.SecurityOptions = []; },
    (f: ReturnType<typeof fixture>) => { f.info.Architecture = 'aarch64'; },
  ]) {
    const f = fixture(); change(f);
    await assert.rejects(f.core.execute(createPlan, f.context), /unsafe_container_spec|dependency_unavailable/);
    assert.equal(f.requests.filter(request => request.method !== 'GET').length, 0);
    assert.equal(f.events.filter(event => event.startsWith('permit')).length, 0);
  }
  const f = fixture(); await assert.rejects(f.core.execute({ ...createPlan, resource_id: binding.resource_id }, f.context), /resource_already_managed/);
});

test('pull uses only a digest/arch request and a fresh step permit; stream errors never expose daemon text', async () => {
  const f = fixture();
  const result = await f.core.execute({ operation: 'pull', image, platform: 'linux/amd64' }, f.context);
  assert.deepEqual(result.image, { digest, platform: 'linux/amd64' });
  assert.equal(f.events[1], 'permit docker.pull');
  assert.equal(f.requests[1].method, 'POST');
  const url = new URL(f.requests[1].path, 'http://local');
  assert.equal(url.searchParams.get('fromImage'), image); assert.equal(url.searchParams.get('platform'), 'linux/amd64');
  f.replace(request => request.path.includes('/images/create') ? { statusCode: 200, body: '{"error":"secret registry password"}\n' } : undefined);
  await assert.rejects(f.core.execute({ operation: 'pull', image, platform: 'linux/amd64' }, f.context), error => error instanceof Error && error.message === 'execution_unknown' && !error.message.includes('secret'));
});

test('managed state writes use full IDs and step permits; remove never forces deletion or deletes volumes', async () => {
  const f = fixture();
  for (const operation of ['stop', 'start', 'restart'] as const) {
    const result = await f.core.execute({ operation, resource_id: binding.resource_id, revision: binding.revision }, f.context);
    assert.equal(result.resource!.state, operation === 'stop' ? 'exited' : 'running');
    assert.deepEqual(result.resources, [binding]);
    const marker = f.events.indexOf('permit docker.' + operation);
    assert.match(f.events[marker + 1], new RegExp('^POST /v1.43/containers/' + id + '/' + operation));
  }
  const result = await f.core.execute({ operation: 'remove', resource_id: binding.resource_id, revision: binding.revision }, f.context);
  assert.deepEqual(result.resources, []); assert.deepEqual(f.context.resources, [binding]);
  assert.equal(f.requests.at(-1)!.path, '/v1.43/containers/' + id + '?force=0&v=0'); assert.equal(f.requests.at(-1)!.method, 'DELETE');
});

test('start/restart do not activate containers whose isolation differs from the safe profile', async () => {
  for (const change of [
    (row: any) => { row.HostConfig.NetworkMode = 'container:' + externalId; },
    (row: any) => { row.HostConfig.Privileged = true; },
    (row: any) => { row.HostConfig.SecurityOpt = ['seccomp=unconfined']; },
    (row: any) => { row.HostConfig.UsernsMode = 'host'; },
    (row: any) => { row.HostConfig.Devices = [{ PathOnHost: '/dev/sda' }]; },
    (row: any) => { row.Mounts = [{ Source: '/var/run/docker.sock' }]; },
  ]) {
    const f = fixture(); change(f.containers.get(id));
    await assert.rejects(f.core.execute({ operation: 'restart', resource_id: binding.resource_id, revision: 7 }, f.context), /unsafe_container_spec/);
    assert.equal(f.requests.filter(request => request.method !== 'GET').length, 0);
  }
});

test('permit/journal refusal produces no write; cancellation and uncertain daemon outcomes do not trigger retries', async () => {
  const f = fixture();
  await assert.rejects(f.core.execute(createPlan, { ...f.context, beforeStep: async () => { throw Error('journal_fsync_failed'); } }), /journal_fsync_failed/);
  assert.equal(f.requests.filter(request => request.method !== 'GET').length, 0);
  const aborted = new AbortController(); aborted.abort();
  const count = f.requests.length;
  await assert.rejects(f.core.execute(createPlan, f.context, aborted.signal), /execution_cancelled/); assert.equal(f.requests.length, count);
  f.replace(request => { if (request.method === 'POST') throw Error('secret lost daemon response'); return undefined; });
  await assert.rejects(f.core.execute(createPlan, f.context), /^ManagedDockerError: execution_unknown$/);
  assert.equal(f.requests.filter(request => request.method === 'POST').length, 1);
  assert.deepEqual(f.context.resources, [binding]);
});

test('async callbacks cannot replace the validated payload or resource binding', async () => {
  const f = fixture(); const plan: any = { operation: 'stop', resource_id: binding.resource_id, revision: 7 };
  const mutable = { ...binding };
  const result = await f.core.execute(plan, { resources: [mutable], beforeStep: async () => { plan.operation = 'exec'; mutable.docker_id = externalId; } });
  assert.equal(result.operation, 'stop'); assert.equal(result.resource!.docker_id, id);
  assert.equal(f.requests.find(request => request.method === 'POST')!.path, '/v1.43/containers/' + id + '/stop?t=10');
});

test('list is bounded and socket metadata rejects symlinks, non-root ownership and world writes', async () => {
  const f = fixture();
  f.replace(request => request.path.includes('/containers/json?') ? { statusCode: 200, body: Array.from({ length: 201 }, (_, index) => ({ Id: index.toString(16).padStart(64, '0'), ImageID: imageId, State: 'running', Env: 'do-not-leak' })) } : undefined);
  const result = await f.core.execute({ operation: 'list' }, f.context);
  assert.equal(result.containers!.length, 200); assert.equal(result.truncated, true); assert.doesNotMatch(JSON.stringify(result), /do-not-leak/);
  const metadata = { uid: 0, mode: 0o660, isSocket: () => true, isSymbolicLink: () => false };
  assert.doesNotThrow(() => validateManagedDockerSocketMetadata(metadata));
  for (const changed of [{ uid: 1000 }, { mode: 0o666 }, { isSocket: () => false }, { isSymbolicLink: () => true }]) assert.throws(() => validateManagedDockerSocketMetadata({ ...metadata, ...changed }), /unsafe_docker_socket/);
  assert.equal(MANAGED_DOCKER_SOCKET, '/var/run/docker.sock');
  assert.throws(() => new ManagedDockerExecutor({ daemon_id: daemon, socketPath: '/tmp/docker.sock' } as any), /unsafe_container_spec/);
  assert.throws(() => new ManagedDockerExecutor({ daemon_id: daemon, transport: async () => ({}) } as any), /unsafe_container_spec/);
});

test('all Docker mutations carry the final permit guard across the transport boundary', async () => {
  const f = fixture(); let assertions = 0;
  const assertStart = () => { assertions++; };
  f.replace(request => {
    if (request.method !== 'GET') { assert.equal(request.assertStart, assertStart); request.assertStart!(); }
    return undefined;
  });
  const context = { ...f.context, assertStart };
  await f.core.execute({ operation: 'pull', image, platform: 'linux/amd64' }, context);
  await f.core.execute(createPlan, context);
  for (const operation of ['stop', 'start', 'restart', 'remove'] as const) await f.core.execute({ operation, resource_id: binding.resource_id, revision: 7 }, context);
  assert.equal(assertions, 6);
  assert.equal(f.requests.filter(request => request.method !== 'GET').length, 6);
  assert(f.requests.filter(request => request.method === 'GET').every(request => request.assertStart === undefined));
});

test('a permit expiring during socket checks blocks the final Docker side effect without retrying', async () => {
  const f = fixture(); let assertions = 0, effects = 0, carried: (() => void) | undefined;
  const assertStart = () => { assertions++; throw Error('expired_permit'); };
  f.replace(request => {
    if (request.method !== 'GET') { carried = request.assertStart; request.assertStart!(); effects++; }
    return undefined;
  });
  await assert.rejects(f.core.execute(createPlan, { ...f.context, assertStart }), /execution_unknown/);
  assert.equal(carried, assertStart); assert.equal(assertions, 1); assert.equal(effects, 0);
  assert.equal(f.containers.has(createdId), false); assert.deepEqual(f.context.resources, [binding]);
  assert.equal(f.requests.filter(request => request.method !== 'GET').length, 1);
});

test('daemon readiness requires Linux, a supported native architecture and active seccomp support', () => {
  const ready = { ID: daemon, OSType: 'linux', Architecture: 'x86_64', SecurityOptions: ['name=seccomp,profile=builtin'] };
  for (const Architecture of ['amd64', 'x86_64', 'arm64', 'aarch64']) assert.deepEqual(validateManagedDockerDaemonInfo({ ...ready, Architecture }), { daemon_id: daemon });
  for (const changed of [
    { ID: '' }, { ID: 'x'.repeat(129) }, { ID: 'socket://external' }, { OSType: 'windows' },
    { Architecture: 'arm/v7' }, { Architecture: {} }, { SecurityOptions: [] }, { SecurityOptions: ['name=apparmor'] },
    { SecurityOptions: ['name=seccomp-disabled'] }, { SecurityOptions: ['seccomp'] },
  ]) assert.throws(() => validateManagedDockerDaemonInfo({ ...ready, ...changed }), /dependency_unavailable/);
});

test('start and restart refuse a daemon that lost seccomp support before requesting a new permit', async () => {
  for (const operation of ['start', 'restart'] as const) {
    const f = fixture(); f.info.SecurityOptions = [];
    await assert.rejects(f.core.execute({ operation, resource_id: binding.resource_id, revision: 7 }, f.context), /dependency_unavailable/);
    assert.equal(f.requests.filter(request => request.method !== 'GET').length, 0);
    assert.equal(f.events.filter(event => event.startsWith('permit')).length, 0);
  }
});
