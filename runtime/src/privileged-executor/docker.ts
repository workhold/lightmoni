import { lstat, realpath } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

/** Production deliberately has no endpoint/context/transport option. */
export const MANAGED_DOCKER_SOCKET = '/var/run/docker.sock';
const API = '/v1.43';
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_CONTAINERS = 200;
const FULL_ID = /^[a-f0-9]{64}$/;
const IMAGE = /^(?:[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]{1,5})?\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[a-f0-9]{64}$/;
const RESOURCE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const STATES = new Set(['created', 'running', 'paused', 'restarting', 'removing', 'exited', 'dead']);

export class ManagedDockerError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'ManagedDockerError'; }
}
function fail(code: string): never { throw new ManagedDockerError(code); }
type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('unsafe_container_spec');
  return value as JsonObject;
};
function keys(value: JsonObject, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) fail('unsafe_container_spec');
}
function text(value: unknown, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value)) fail('unsafe_container_spec');
  return value as string;
}
function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) fail('unsafe_container_spec');
  return value as number;
}
function record(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('dependency_unavailable');
  return value as JsonObject;
}
function parseBody(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return fail('dependency_unavailable'); }
}

export interface ManagedDockerResource {
  daemon_id: string;
  resource_id: string;
  docker_id: string;
  revision: number;
}
export interface ManagedDockerConfig { daemon_id: string }
export interface ManagedDockerContext {
  /** Must come from the root-owned durable journal, never from a job payload. */
  resources: readonly ManagedDockerResource[];
  /** The caller must persist intent/consume a fresh permit before resolving. */
  beforeStep: (step_id: string) => Promise<void>;
  /** Recheck the already-issued permit immediately before crossing into Docker. */
  assertStart?: () => void;
}
export type ManagedDockerPayload =
  | { operation: 'list'; docker_id?: string }
  | { operation: 'pull'; image: string; platform: 'linux/amd64' | 'linux/arm64' }
  | { operation: 'create'; resource_id: string; revision: number; image: string; platform: 'linux/amd64' | 'linux/arm64'; name?: string; command?: string[] }
  | { operation: 'start' | 'stop' | 'restart' | 'remove'; resource_id: string; revision: number };
export interface ManagedDockerSummary {
  docker_id: string;
  image_id: string;
  state: string;
  managed: boolean;
  resource_id?: string;
  revision?: number;
}
export interface ManagedDockerResult {
  operation: ManagedDockerPayload['operation'];
  daemon_id: string;
  resources: ManagedDockerResource[];
  containers?: ManagedDockerSummary[];
  resource?: ManagedDockerSummary;
  truncated?: boolean;
  image?: { digest: string; platform: string };
}
export interface ManagedDockerRequest { method: 'GET' | 'POST' | 'DELETE'; path: string; body?: JsonObject; signal?: AbortSignal; assertStart?: () => void }
export interface ManagedDockerResponse { statusCode: number; body: unknown }
export type ManagedDockerTransport = (request: ManagedDockerRequest) => Promise<ManagedDockerResponse>;

function payload(value: unknown): ManagedDockerPayload {
  const input = object(value);
  switch (input.operation) {
    case 'list':
      keys(input, ['operation', 'docker_id']);
      if (input.docker_id !== undefined) text(input.docker_id, FULL_ID);
      break;
    case 'pull':
    case 'create':
      keys(input, input.operation === 'pull' ? ['operation', 'image', 'platform'] : ['operation', 'resource_id', 'revision', 'image', 'platform', 'name', 'command']);
      text(input.image, IMAGE);
      if (Buffer.byteLength(input.image as string) > 512 || typeof input.platform !== 'string' || !['linux/amd64', 'linux/arm64'].includes(input.platform)) fail('unsafe_container_spec');
      if (input.operation === 'create') {
        text(input.resource_id, RESOURCE); revision(input.revision);
        if (input.name !== undefined) text(input.name, /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/);
        if (input.command !== undefined && (!Array.isArray(input.command) || input.command.length < 1 || input.command.length > 32 || input.command.some(arg => typeof arg !== 'string' || arg.includes('\0') || Buffer.byteLength(arg) > 1024))) fail('unsafe_container_spec');
      }
      break;
    case 'start': case 'stop': case 'restart': case 'remove':
      keys(input, ['operation', 'resource_id', 'revision']);
      text(input.resource_id, RESOURCE); revision(input.revision);
      break;
    default: fail('unsafe_container_spec');
  }
  // Snapshot caller-owned objects before the first await (including command arrays).
  return JSON.parse(JSON.stringify(input)) as ManagedDockerPayload;
}

function resources(value: readonly ManagedDockerResource[], daemonId: string): ManagedDockerResource[] {
  if (!Array.isArray(value) || value.length > 10000) fail('invalid_resource_manifest');
  const ids = new Set<string>(), dockerIds = new Set<string>();
  return value.map(item => {
    const row = object(item); keys(row, ['daemon_id', 'resource_id', 'docker_id', 'revision']);
    if (row.daemon_id !== daemonId || typeof row.resource_id !== 'string' || !RESOURCE.test(row.resource_id) || typeof row.docker_id !== 'string' || !FULL_ID.test(row.docker_id) || !Number.isSafeInteger(row.revision) || Number(row.revision) < 1 || ids.has(row.resource_id) || dockerIds.has(row.docker_id)) fail('invalid_resource_manifest');
    ids.add(row.resource_id); dockerIds.add(row.docker_id);
    return { daemon_id: daemonId, resource_id: row.resource_id, docker_id: row.docker_id, revision: row.revision as number };
  });
}

/** This is metadata validation only; production always obtains it using lstat. */
export function validateManagedDockerSocketMetadata(stat: { uid: number; mode: number; isSocket(): boolean; isSymbolicLink(): boolean }): void {
  if (stat.isSymbolicLink() || !stat.isSocket() || stat.uid !== 0 || (stat.mode & 0o002) !== 0) fail('unsafe_docker_socket');
}

async function validateProductionSocket(): Promise<void> {
  if (process.platform !== 'linux') fail('dependency_unavailable');
  try {
    // /var/run -> /run is the sole permitted system alias; the socket may not be a symlink.
    const varStat = await lstat('/var');
    if (varStat.isSymbolicLink() || !varStat.isDirectory() || varStat.uid !== 0 || (varStat.mode & 0o022)) fail('unsafe_docker_socket');
    const runStat = await lstat('/var/run');
    if (runStat.uid !== 0 || (runStat.isSymbolicLink() ? await realpath('/var/run') !== '/run' : !runStat.isDirectory() || !!(runStat.mode & 0o022))) fail('unsafe_docker_socket');
    const canonical = await realpath('/var/run');
    const canonicalStat = await lstat(canonical);
    if (!canonicalStat.isDirectory() || canonicalStat.uid !== 0 || (canonicalStat.mode & 0o022)) fail('unsafe_docker_socket');
    const root = await lstat(path.parse(canonical).root);
    if (!root.isDirectory() || root.uid !== 0 || (root.mode & 0o022)) fail('unsafe_docker_socket');
    validateManagedDockerSocketMetadata(await lstat(MANAGED_DOCKER_SOCKET));
  } catch (error) {
    if (error instanceof ManagedDockerError) throw error;
    fail('dependency_unavailable');
  }
}

/** Real Docker Engine HTTP over the fixed local Unix socket; no CLI or shell. */
async function productionTransport(request: ManagedDockerRequest): Promise<ManagedDockerResponse> {
  await validateProductionSocket();
  if (request.signal?.aborted) fail('execution_cancelled');
  return new Promise((resolve, reject) => {
    let settled = false;
    let deadline: NodeJS.Timeout | undefined;
    const finish = (error: unknown, response?: ManagedDockerResponse) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      if (error) reject(error); else resolve(response!);
    };
    const encoded = request.body ? JSON.stringify(request.body) : undefined;
    if (request.method !== 'GET') {
      if (typeof request.assertStart !== 'function') fail('start_permit_required');
      request.assertStart();
    }
    const req = http.request({ socketPath: MANAGED_DOCKER_SOCKET, method: request.method, path: request.path, signal: request.signal,
      headers: encoded ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(encoded) } : {} }, response => {
      const chunks: Buffer[] = []; let bytes = 0;
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_RESPONSE_BYTES) {
          const error = new ManagedDockerError('docker_response_too_large');
          finish(error); req.destroy(error); return;
        }
        chunks.push(chunk);
      });
      response.on('error', error => finish(error));
      response.on('aborted', () => finish(new ManagedDockerError('dependency_unavailable')));
      response.on('end', () => finish(undefined, { statusCode: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    // A wall-clock deadline also bounds a peer that trickles data indefinitely.
    deadline = setTimeout(() => req.destroy(new ManagedDockerError('docker_request_timeout')), 30000);
    deadline.unref();
    req.on('error', error => finish(error));
    req.end(encoded);
  });
}

/** Pure validation also used by enrollment/readiness; never accepts an endpoint. */
export function validateManagedDockerDaemonInfo(value: unknown): { daemon_id: string } {
  const info = record(value);
  const architecture = info.Architecture === 'x86_64' ? 'amd64' : info.Architecture === 'aarch64' ? 'arm64' : info.Architecture;
  if (typeof info.ID !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9:_.-]{0,127}$/.test(info.ID)
    || info.OSType !== 'linux' || architecture !== 'amd64' && architecture !== 'arm64'
    || !Array.isArray(info.SecurityOptions) || !info.SecurityOptions.some(option => typeof option === 'string' && /^name=seccomp(?:,|$)/.test(option))) fail('dependency_unavailable');
  return { daemon_id: info.ID };
}

/** Enrollment observes this once, then pins it in the root-owned configuration. */
export async function inspectManagedDockerDaemon(): Promise<{ daemon_id: string }> {
  try {
    const response = await productionTransport({ method: 'GET', path: `${API}/info` });
    if (response.statusCode < 200 || response.statusCode >= 300) fail('dependency_unavailable');
    return validateManagedDockerDaemonInfo(parseBody(response.body));
  } catch { return fail('dependency_unavailable'); }
}

class ManagedDockerCore {
  private readonly daemonId: string;
  constructor(config: ManagedDockerConfig, private readonly transport: ManagedDockerTransport) {
    const input = object(config); keys(input, ['daemon_id']);
    this.daemonId = text(input.daemon_id, /^[a-zA-Z0-9][a-zA-Z0-9:_.-]{0,127}$/);
  }

  private async request(method: ManagedDockerRequest['method'], route: string, signal?: AbortSignal, body?: JsonObject, assertStart?: () => void): Promise<ManagedDockerResponse> {
    if (signal?.aborted) fail('execution_cancelled');
    try {
      const response = await this.transport({ method, path: `${API}${route}`, body, signal, assertStart });
      if (response.statusCode < 200 || response.statusCode >= 300) fail('docker_operation_rejected');
      return response;
    } catch (error) {
      if (error instanceof ManagedDockerError) throw error;
      return fail('dependency_unavailable');
    }
  }

  private async inspect(id: string, signal?: AbortSignal): Promise<JsonObject> {
    const result = record(parseBody((await this.request('GET', `/containers/${id}/json`, signal)).body));
    if (result.Id !== id) fail('resource_identity_mismatch');
    return result;
  }

  private summary(value: unknown, manifest: readonly ManagedDockerResource[]): ManagedDockerSummary {
    const row = record(value);
    if (typeof row.Id !== 'string' || !FULL_ID.test(row.Id)) fail('dependency_unavailable');
    const binding = manifest.find(item => item.docker_id === row.Id);
    const stateValue = typeof row.State === 'string' ? row.State : record(row.State).Status;
    const state = STATES.has(String(stateValue)) ? String(stateValue) : 'unknown';
    const imageId = typeof row.ImageID === 'string' ? row.ImageID : row.Image;
    return { docker_id: row.Id, image_id: typeof imageId === 'string' && /^sha256:[a-f0-9]{64}$/.test(imageId) ? imageId : '', state, managed: !!binding,
      ...(binding ? { resource_id: binding.resource_id, revision: binding.revision } : {}) };
  }

  private async verifyImage(image: string, platform: string, signal?: AbortSignal): Promise<void> {
    const row = record(parseBody((await this.request('GET', `/images/${encodeURIComponent(image)}/json`, signal)).body));
    const digest = image.slice(image.lastIndexOf('@') + 1);
    if (row.Os !== 'linux' || row.Architecture !== platform.split('/')[1] || !Array.isArray(row.RepoDigests) || !row.RepoDigests.some(ref => typeof ref === 'string' && ref.endsWith(`@${digest}`))) fail('unsafe_container_spec');
    const volumes = record(row.Config ?? {}).Volumes;
    if (volumes !== undefined && volumes !== null && Object.keys(record(volumes)).length !== 0) fail('unsafe_container_spec');
  }

  private assertSafeRunningProfile(row: JsonObject): void {
    const host = record(row.HostConfig), config = record(row.Config);
    if (config.User !== '65532:65532' || host.Privileged !== false || host.ReadonlyRootfs !== true || host.NetworkMode !== 'none' || host.IpcMode !== 'private' || !['', undefined].includes(host.PidMode as string | undefined) || !['', undefined].includes(host.UTSMode as string | undefined) || !['', undefined].includes(host.UsernsMode as string | undefined) || host.CgroupnsMode !== 'private' || host.Runtime !== 'runc') fail('unsafe_container_spec');
    for (const key of ['Binds', 'Mounts', 'VolumesFrom', 'Devices', 'DeviceRequests', 'CapAdd']) if (host[key] !== undefined && host[key] !== null && (!Array.isArray(host[key]) || (host[key] as unknown[]).length !== 0)) fail('unsafe_container_spec');
    if (Array.isArray(row.Mounts) && row.Mounts.length) fail('unsafe_container_spec');
    if (!Array.isArray(host.CapDrop) || host.CapDrop.length !== 1 || host.CapDrop[0] !== 'ALL' || !Array.isArray(host.SecurityOpt) || host.SecurityOpt.length !== 1 || !['no-new-privileges', 'no-new-privileges:true'].includes(String(host.SecurityOpt[0]))) fail('unsafe_container_spec');
    if (host.PortBindings && Object.keys(record(host.PortBindings)).length || host.PublishAllPorts === true) fail('unsafe_container_spec');
  }

  async execute(value: unknown, context: ManagedDockerContext, signal?: AbortSignal): Promise<ManagedDockerResult> {
    const plan = payload(value), manifest = resources(context.resources, this.daemonId);
    if (typeof context.beforeStep !== 'function' || context.assertStart !== undefined && typeof context.assertStart !== 'function') fail('invalid_execution_context');
    const beforeStep = context.beforeStep, assertStart = context.assertStart;
    const info = record(parseBody((await this.request('GET', '/info', signal)).body));
    if (info.ID !== this.daemonId) fail('daemon_identity_mismatch');
    if (['pull', 'create', 'start', 'restart'].includes(plan.operation)) validateManagedDockerDaemonInfo(info);
    const base: ManagedDockerResult = { operation: plan.operation, daemon_id: this.daemonId, resources: manifest };
    if (plan.operation === 'list') {
      if (plan.docker_id) return { ...base, containers: [this.summary(await this.inspect(plan.docker_id, signal), manifest)], truncated: false };
      const rows = parseBody((await this.request('GET', `/containers/json?all=1&limit=${MAX_CONTAINERS + 1}`, signal)).body);
      if (!Array.isArray(rows)) fail('dependency_unavailable');
      return { ...base, containers: (rows as unknown[]).slice(0, MAX_CONTAINERS).map(row => this.summary(row, manifest)), truncated: (rows as unknown[]).length > MAX_CONTAINERS };
    }
    if (plan.operation === 'pull' || plan.operation === 'create') {
      const architecture = info.Architecture === 'x86_64' ? 'amd64' : info.Architecture === 'aarch64' ? 'arm64' : info.Architecture;
      if (info.OSType !== 'linux' || architecture !== plan.platform.split('/')[1] || !Array.isArray(info.SecurityOptions) || !info.SecurityOptions.some(option => typeof option === 'string' && /^name=seccomp(?:,|$)/.test(option))) fail('dependency_unavailable');
    }
    if (plan.operation === 'pull') {
      await beforeStep('docker.pull');
      try {
        const response = await this.request('POST', `/images/create?fromImage=${encodeURIComponent(plan.image)}&platform=${encodeURIComponent(plan.platform)}`, signal, undefined, assertStart);
        const events = typeof response.body === 'string' ? response.body.trim().split('\n').filter(Boolean).map(line => parseBody(line)) : [response.body];
        if (!events.length || events.some(event => record(event).error || record(event).errorDetail)) fail('docker_operation_rejected');
        await this.verifyImage(plan.image, plan.platform, signal);
        return { ...base, image: { digest: plan.image.slice(plan.image.lastIndexOf('@') + 1), platform: plan.platform } };
      } catch { return fail('execution_unknown'); }
    }
    if (plan.operation === 'create') {
      if (manifest.some(item => item.resource_id === plan.resource_id)) fail('resource_already_managed');
      await this.verifyImage(plan.image, plan.platform, signal);
      const body: JsonObject = { Image: plan.image, User: '65532:65532', ...(plan.command ? { Cmd: plan.command } : {}),
        HostConfig: { Privileged: false, ReadonlyRootfs: true, NetworkMode: 'none', IpcMode: 'private', PidMode: '', UTSMode: '', UsernsMode: '', CgroupnsMode: 'private', Runtime: 'runc',
          CapAdd: [], CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges:true'], Binds: [], Mounts: [], VolumesFrom: [], Devices: [], DeviceRequests: [], PortBindings: {}, PublishAllPorts: false,
          Memory: 268435456, MemorySwap: 268435456, NanoCpus: 1000000000, PidsLimit: 64, OomKillDisable: false, AutoRemove: false, RestartPolicy: { Name: 'no' }, LogConfig: { Type: 'json-file', Config: { 'max-size': '1m', 'max-file': '1' } } } };
      await beforeStep('docker.create');
      try {
        const query = `platform=${encodeURIComponent(plan.platform)}${plan.name ? `&name=${encodeURIComponent(plan.name)}` : ''}`;
        const created = record(parseBody((await this.request('POST', `/containers/create?${query}`, signal, body, assertStart)).body));
        if (typeof created.Id !== 'string' || !FULL_ID.test(created.Id) || manifest.some(item => item.docker_id === created.Id)) fail('resource_identity_mismatch');
        const next = [...manifest, { daemon_id: this.daemonId, resource_id: plan.resource_id, docker_id: created.Id as string, revision: plan.revision }];
        const observed = await this.inspect(created.Id as string, signal); this.assertSafeRunningProfile(observed);
        return { ...base, resources: next, resource: this.summary(observed, next) };
      } catch { return fail('execution_unknown'); }
    }
    const binding = manifest.find(item => item.resource_id === plan.resource_id);
    if (!binding) fail('resource_not_managed');
    if (binding.revision !== plan.revision) fail('resource_revision_mismatch');
    const observed = await this.inspect(binding.docker_id, signal);
    if (plan.operation === 'start' || plan.operation === 'restart') this.assertSafeRunningProfile(observed);
    await beforeStep(`docker.${plan.operation}`);
    try {
      if (plan.operation === 'remove') {
        await this.request('DELETE', `/containers/${binding.docker_id}?force=0&v=0`, signal, undefined, assertStart);
        // No follow-up write, retry, force removal, or volume deletion is performed.
        return { ...base, resources: manifest.filter(item => item.resource_id !== binding.resource_id) };
      }
      await this.request('POST', `/containers/${binding.docker_id}/${plan.operation}${plan.operation === 'start' ? '' : '?t=10'}`, signal, undefined, assertStart);
      const result = this.summary(await this.inspect(binding.docker_id, signal), manifest);
      if (plan.operation === 'stop' ? !['exited', 'created'].includes(result.state) : result.state !== 'running') fail('execution_unknown');
      return { ...base, resource: result };
    } catch { return fail('execution_unknown'); }
  }
}

/** Trusted production entry point. The only configurable value is daemon identity. */
export class ManagedDockerExecutor extends ManagedDockerCore {
  constructor(config: ManagedDockerConfig) { super(config, productionTransport); }
}

/** Pure core for deterministic tests. Never used by the production entry point. */
export function createManagedDockerCoreForTests(config: ManagedDockerConfig, transport: ManagedDockerTransport): Pick<ManagedDockerExecutor, 'execute'> {
  return new ManagedDockerCore(config, transport);
}
