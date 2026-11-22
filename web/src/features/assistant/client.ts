import type {Language} from '../../shared/i18n';
import {translator} from '../alerts/translation.ts';
import type { AssistantContext, AssistantEvent, AssistantSession, Attachment } from './types';

/** Recognizable turn-stream failures so the UI can recover instead of erroring. */
export class TurnStreamError extends Error {
  readonly code: 'http' | 'protocol' | 'disconnected';
  constructor(code: 'http' | 'protocol' | 'disconnected', message: string) {
    super(message);
    this.code = code;
  }
}

export async function streamTurn(sessionId: string, text: string, context: AssistantContext | undefined, onEvent: (event: AssistantEvent) => void, signal: AbortSignal, language:Language='zh-CN', attachments: Attachment[]=[]): Promise<void> {
 const t=translator(language);
  const response = await fetch(`/api/v1/assistant/sessions/${encodeURIComponent(sessionId)}/turns`, {
    method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ text, context, ...(attachments.length ? {attachments} : {}) }), signal,
  }).catch(problem => { if (signal.aborted) throw problem; throw new TurnStreamError('disconnected', t('连接助手服务失败','Could not reach the assistant service')); });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new TurnStreamError('http', body.error ?? t(`AI 请求失败 (${response.status})`,`AI request failed (${response.status})`));
  }
  if (!response.body || !response.headers.get('Content-Type')?.includes('text/event-stream')) throw new TurnStreamError('protocol', t("服务未返回有效的流式回复","The service did not return a valid streaming response"));
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', completed = false;
  try {
    while (true) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try { chunk = await reader.read(); }
      catch (problem) {
        if (signal.aborted) throw problem;
        throw new TurnStreamError('disconnected', t("连接已中断，请读取会话历史确认结果","Connection interrupted. Check conversation history to verify the result."));
      }
      const { value, done } = chunk;
      buffer += decoder.decode(value, { stream: !done });
      buffer = buffer.replace(/\r\n/g, '\n');
      if (buffer.length > 512 * 1024) throw new TurnStreamError('protocol', t("流式事件超过大小限制","Streaming event exceeded the size limit"));
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!data) continue;
        let event: AssistantEvent;
        try { event = JSON.parse(data) as AssistantEvent; }
        catch { throw new TurnStreamError('protocol', t("流式事件格式错误","Invalid streaming event format")); }
        if (!Number.isSafeInteger(event.sequence) || !event.turn_id || !event.type || !event.data) throw new TurnStreamError('protocol', t("流式事件格式错误","Invalid streaming event format"));
        onEvent(event);
        if (['turn.completed', 'turn.failed', 'turn.cancelled'].includes(event.type)) completed = true;
      }
      if (done) break;
    }
    if (!completed && !signal.aborted) throw new TurnStreamError('disconnected', t("连接已中断，请读取会话历史确认结果","Connection interrupted. Check conversation history to verify the result."));
  } finally { reader.releaseLock(); }
}

export async function fetchSession(sessionId: string, signal?: AbortSignal): Promise<AssistantSession> {
  const response = await fetch(`/api/v1/assistant/sessions/${encodeURIComponent(sessionId)}`, { credentials: 'include', signal });
  if (!response.ok) throw new TurnStreamError('http', `session reload failed (${response.status})`);
  return await response.json() as AssistantSession;
}
