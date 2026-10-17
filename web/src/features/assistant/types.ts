import type { SQLQuery, TimeRange } from '../../shared/types';

export type ModelProtocol = 'openai-chat-completions' | 'openai-responses' | 'anthropic-messages' | 'google-generative-ai';
export type ModelProtocolSelection = ModelProtocol | 'auto';
export type ReasoningEffort = 'provider-default' | 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export type ModelProtocolSource = 'manual' | 'official-host' | 'endpoint-path' | 'catalog' | 'default';
export interface AssistantConfig { base_url: string; model: string; has_key: boolean; enabled: boolean; runtime?: string; protocol?: ModelProtocol; max_input_tokens?: number; max_output_tokens?: number; max_steps?: number; reasoning_effort?: ReasoningEffort; code_tasks_enabled?: boolean; code_workspace?: string }
export interface ModelDiscoveryInput { base_url: string; api_key: string; use_saved_key: boolean; protocol: ModelProtocolSelection }
export interface ModelDiscoveryResult { base_url: string; protocol: ModelProtocol; protocol_options: ModelProtocol[]; protocol_source: ModelProtocolSource; requires_confirmation: boolean; capabilities_verified: false; models: {id: string; label?: string}[]; truncated: boolean }
export interface ModelConnectionTestResult { ok: true; base_url: string; protocol: ModelProtocol; model: string; latency_ms: number }
export interface AssistantEvent { sequence: number; session_id: string; turn_id: string; type: string; timestamp: string; data: Record<string, unknown> }
export interface AssistantMessage { role: 'user' | 'assistant' | 'tool'; content: string; tool_calls?: unknown[]; tool_call_id?: string }
export interface AssistantSession { id: string; user_id: string; title: string; created_at: string; updated_at: string; messages: AssistantMessage[] | null; events: AssistantEvent[] | null }
export interface AssistantContext { table?: string; service?: string; services?: string[]; filters?: unknown[]; range?: TimeRange; dashboard_id?: string; selected_logs?: unknown[]; code_workspace?: string;
  page?: {path: string; title: string}; dashboard_title?: string;
  panels?: {id: string; title: string; type: string; queries: SQLQuery[]}[];
  variables?: Record<string, string|string[]>;
  query?: {sql: string; params?: Record<string, unknown>; range?: TimeRange; parameter_error?: string; lookback_hours?: number};
  log_query?: {keyword: string; mode: string; sql?: string; params?: Record<string, unknown>; sort: string; syntax?: string};
  status?: {loading?: boolean; error?: string; result_rows?: number; truncated?: boolean};
  context_truncated?: boolean;
}
export interface DraftPanel { id?: string; title: string; type: string; queries: SQLQuery[]; options?: Record<string, unknown>; grid?: Record<string, number> }
export interface DashboardDraft { title: string; description?: string; panels: DraftPanel[]; range?: TimeRange }
export interface CodeTaskResult {
  workspace?: string;
  id: string;
  status: 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'cancelled';
  summary: string;
  diff: string;
  changed_files: string[];
  checks: { command: string; status: 'passed' | 'failed' | 'skipped'; output: string }[];
  steps: { index: number; action: string; status: 'started' | 'completed' | 'failed' | 'cancelled' }[];
  created_at: string;
  expires_at: string;
}
export interface ToolTrace { callId: string; name: string; input: unknown; result?: unknown; status: 'running' | 'success' | 'error' }
export interface TurnView { id: string; text: string; answer: string; tools: ToolTrace[]; timestamp: string; status: 'running' | 'completed' | 'failed' | 'cancelled'; error?: string; compacting?: boolean; compacted?: boolean; usage?: {input_tokens?: number; output_tokens?: number; total_tokens?: number}; compactionUsage?: {input_tokens?: number; output_tokens?: number; total_tokens?: number} }
