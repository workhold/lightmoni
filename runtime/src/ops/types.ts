import type { Dependencies, Module } from "../shared/types.js";
import type { AgentJobStore, AgentJobUpdate } from "../server/agent-jobs.js";
export type ResourceKind =
  | "credential"
  | "dns_zone"
  | "acme_account"
  | "certificate"
  | "certificate_target"
  | "cluster"
  | "application"
  | "service"
  | "node_pool"
  | "gateway_group"
  | "website";
export interface PlatformResource {
  id: string;
  kind: ResourceKind;
  name: string;
  revision: number;
  spec: Record<string, any>;
  status: Record<string, any>;
  created_by: string;
  authorized_by: string;
  created_at: string;
  updated_at: string;
}
export interface PlatformRun {
  id: string;
  resource_id: string;
  resource_revision: number;
  agent_id: string;
  action: string;
  state: string;
  result: Record<string, any>;
  job_id: string;
  actor: string;
  dedupe_key: string;
  created_at: string;
  updated_at: string;
}
export interface ResourceDefinition {
  resourceName?(spec: Record<string, any>): string;
  validatePayload?(resource: PlatformResource, config: Record<string, any>, agentID: string): void;
  validate(
    spec: Record<string, any>,
    previous?: Record<string, any>,
    context?: { id: string; systemKind?: 'openresty' | 'registry' },
  ): Record<string, any>;
  afterSave?(resource: PlatformResource, previous?: PlatformResource): void;
  afterDelete?(resource: PlatformResource): void;
  publicSpec?(spec: Record<string, any>): Record<string, any>;
  beforeDelete?(resource: PlatformResource): void;
}
export interface PlatformRunEvent {
  id: string;
  run_id: string;
  resource_id: string;
  sequence: number;
  phase: string;
  state: string;
  created_at: string;
  domain?: string;
  attempt?: number;
  code?: string;
  message?: string;
  error_type?: string;
  http_status?: number;
  request_id?: string;
}
export interface PlatformExecution {
  run: PlatformRun;
  done: Promise<PlatformRun>;
}
export interface PlatformStore {
  deps: Dependencies;
  jobs: AgentJobStore;
  register(kind: ResourceKind, definition: ResourceDefinition): void;
  get(id: string, kind?: ResourceKind): PlatformResource;
  list(kind?: ResourceKind): PlatformResource[];
  public(resource: PlatformResource): PlatformResource;
  create(
    kind: ResourceKind,
    name: string,
    spec: Record<string, any>,
    actor: string,
  ): PlatformResource;
  createSystemApplication(kind: 'openresty' | 'registry', name: string, spec: Record<string, any>, actor: string): PlatformResource;
  updateSystemApplication(id: string, revision: number, name: string, spec: Record<string, any>, actor: string): PlatformResource;
  update(
    id: string,
    revision: number,
    name: string,
    spec: Record<string, any>,
    actor: string,
  ): PlatformResource;
  patchStatus(id: string, status: Record<string, any>): void;
  remove(id: string, revision: number): void;
  queue(
    resource: PlatformResource,
    agentID: string,
    action: string,
    config: Record<string, any>,
    actor: string,
    idempotencyKey?: string,
  ): PlatformRun;
  run(
    resource: PlatformResource,
    action: string,
    actor: string,
    work: (runID: string) => Promise<Record<string, any>>,
    idempotencyKey?: string,
    input?: Record<string, any>,
  ): Promise<PlatformRun>;
  startRun(
    resource: PlatformResource,
    action: string,
    actor: string,
    work: (runID: string) => Promise<Record<string, any>>,
    idempotencyKey?: string,
    input?: Record<string, any>,
  ): PlatformExecution;
  addRunEvent(runID: string, phase: string, state: string, detail?: Record<string, any>): void;
  runEvents(runID: string, after?: number): PlatformRunEvent[];
  action(runID: string): PlatformRun;
  actions(resourceID?: string): PlatformRun[];
  subscribe(
    listener: (
      run: PlatformRun,
      config: Record<string, any>,
      update: AgentJobUpdate,
    ) => void,
  ): () => void;
  authorized(actor: string): boolean;
}
export interface DomainController extends Module {
  actions(resource: PlatformResource): string[];
  perform(
    resource: PlatformResource,
    action: string,
    input: Record<string, any>,
    actor: string,
  ): Promise<any>;
  tick?(): Promise<void>;
}
export interface PlatformOptions {
  store: PlatformStore;
  deps: Dependencies;
  dataDir: string;
  fetch?: typeof fetch;
}
