import type { SQLQuery, TimeRange } from '../../shared/types';

export interface AssistantConfig { base_url: string; model: string; has_key: boolean; enabled: boolean }
export interface AssistantEvent { sequence: number; session_id: string; turn_id: string; type: string; timestamp: string; data: Record<string, unknown> }
export interface AssistantMessage { role: 'user' | 'assistant' | 'tool'; content: string; tool_calls?: unknown[]; tool_call_id?: string }
export interface AssistantSession { id: string; user_id: string; title: string; created_at: string; updated_at: string; messages: AssistantMessage[] | null; events: AssistantEvent[] | null }
export interface AssistantContext { table?: string; service?: string; services?: string[]; filters?: unknown[]; range?: TimeRange; dashboard_id?: string; selected_logs?: unknown[];
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
export interface ToolTrace { callId: string; name: string; input: unknown; result?: unknown; status: 'running' | 'success' | 'error' }
export interface TurnView { id: string; text: string; answer: string; tools: ToolTrace[]; timestamp: string; status: 'running' | 'completed' | 'failed' | 'cancelled'; error?: string }
