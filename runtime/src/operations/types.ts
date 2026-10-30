export type OperationKind = "website" | "certificate" | "compose" | "backup" | "platform";
export type OperationConfig = Record<string, any>;
export interface OperationDefinition {
  kind: OperationKind;
  operations: readonly string[];
  readOnly: readonly string[];
  validate(config: unknown): OperationConfig;
  publicConfig(config: OperationConfig): OperationConfig;
  validateInput(operation: string, input: unknown, config: OperationConfig): OperationConfig;
}
export interface OperationResource {
  id: string; kind: OperationKind; name: string; agent_id: string;
  revision: number; config: OperationConfig; created_at: string; updated_at: string;
}
export interface OperationPayload {
  version: 1; operation_id: string; operation: string;
  resource: OperationResource; input: OperationConfig;
}
export interface OperationExecutionContext {
  dataDir: string; signal: AbortSignal; now: () => Date;
  publicDir?: string;
  command(file: string, args: string[], options?: { cwd?: string; stdin?: string | Buffer; timeoutMs?: number; signal?: AbortSignal; env?: Record<string,string> }): Promise<{ stdout: string; stderr: string }>;
}
export interface OperationExecutionResult { verified: boolean; data: OperationConfig; }
export interface OperationsStore {
  list(kind?: string): OperationResource[];
  get(id: string): OperationResource;
  plan(id: string, operation: string, input: unknown, actor: string): Record<string, any>;
  approve(id: string, actor: string, revision: number): Record<string, any>;
  getRun(id: string): Record<string, any>;
  runs(resourceID?: string): Record<string, any>[];
  validateOperation(id: string, operation: string, input: unknown): OperationConfig;
}
