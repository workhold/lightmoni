import type {Language} from '../../shared/i18n';
import {translator} from '../alerts/translation.ts';
import type { AssistantContext, AssistantEvent } from './types';

export async function streamTurn(sessionId: string, text: string, context: AssistantContext | undefined, onEvent: (event: AssistantEvent) => void, signal: AbortSignal, language:Language='zh-CN'): Promise<void> {
 const t=translator(language);
  const response = await fetch(`/api/v1/assistant/sessions/${encodeURIComponent(sessionId)}/turns`, {
    method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ text, context }), signal,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? t(`AI 请求失败 (${response.status})`,`AI request failed (${response.status})`));
  }
  if (!response.body || !response.headers.get('Content-Type')?.includes('text/event-stream')) throw new Error(t("服务未返回有效的流式回复","The service did not return a valid streaming response"));
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', completed = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      buffer = buffer.replace(/\r\n/g, '\n');
      if (buffer.length > 512 * 1024) throw new Error(t("流式事件超过大小限制","Streaming event exceeded the size limit"));
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        const data = block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!data) continue;
        const event = JSON.parse(data) as AssistantEvent;
        if (!Number.isSafeInteger(event.sequence) || !event.turn_id || !event.type || !event.data) throw new Error(t("流式事件格式错误","Invalid streaming event format"));
        onEvent(event);
        if (['turn.completed', 'turn.failed', 'turn.cancelled'].includes(event.type)) completed = true;
      }
      if (done) break;
    }
    if (!completed && !signal.aborted) throw new Error(t("连接已中断，请读取会话历史确认结果","Connection interrupted. Check conversation history to verify the result."));
  } finally { reader.releaseLock(); }
}
