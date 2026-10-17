import type { AssistantConfig, ModelDiscoveryResult, ModelProtocol, ModelProtocolSelection, ReasoningEffort } from './types';

export const protocolChoices: { value: ModelProtocolSelection; label: string }[] = [
  { value: 'auto', label: '自动识别' },
  { value: 'openai-chat-completions', label: 'OpenAI 兼容 · Chat Completions' },
  { value: 'openai-responses', label: 'OpenAI · Responses' },
  { value: 'anthropic-messages', label: 'Anthropic · Messages' },
  { value: 'google-generative-ai', label: 'Google Gemini · 原生协议' },
];

export const reasoningEffortChoices: { value: ReasoningEffort; label: string }[] = [
  { value: 'provider-default', label: '跟随模型（自动）' },
  { value: 'none', label: '关闭思考' },
  { value: 'minimal', label: '最小' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
  { value: 'xhigh', label: '极高' },
];

export function isModelProtocol(value: unknown): value is ModelProtocol {
  return protocolChoices.some(option => option.value !== 'auto' && option.value === value);
}

export function protocolLabel(protocol: ModelProtocolSelection): string {
  return protocolChoices.find(option => option.value === protocol)?.label ?? '未知协议';
}

export function initialProtocol(config?: Pick<AssistantConfig, 'base_url' | 'protocol'>): ModelProtocolSelection {
  if (!config?.base_url?.trim()) return 'auto';
  return isModelProtocol(config.protocol) ? config.protocol : 'openai-chat-completions';
}

// Only a current, unambiguous directory recommendation can resolve "auto".
// A concrete choice remains usable when a provider has no model directory.
export function resolveProtocol(selected: ModelProtocolSelection, result?: ModelDiscoveryResult): { protocol?: ModelProtocol; error?: string } {
  if (isModelProtocol(selected)) return { protocol: selected };
  if (selected !== 'auto') return { error: '请选择支持的 API 协议。' };
  if (!result) return { error: '请先获取模型以识别协议，或手动选择 API 协议后保存。' };
  if (result.requires_confirmation !== false) return { error: '此模型目录无法区分实际调用方式，请选择具体 API 协议后保存。' };
  if (!isModelProtocol(result.protocol)) return { error: '未识别出支持的协议，请手动选择 API 协议。' };
  return { protocol: result.protocol };
}

export function protocolSourceLabel(source: string): string {
  switch (source) {
    case 'official-host': return '官方服务地址';
    case 'endpoint-path': return '完整接口地址';
    case 'catalog': return '模型目录格式';
    case 'manual': return '手动选择';
    case 'default': return '服务默认方式';
    default: return '服务返回的信息';
  }
}

// Provider responses and arbitrary exception text never become UI messages.
// Match only fixed server codes or legacy safe error markers.
export function modelConnectionError(problem: unknown): string {
  const issue = problem && typeof problem === 'object' ? problem as { status?: number; details?: { code?: unknown }; message?: unknown } : {};
  const code = issue.details?.code;
  const marker = typeof issue.message === 'string' ? issue.message : '';
  if (code === 'test_budget_exceeded') return '当前思考深度超出连接测试的 256 Token 总输出预算。请改用模型默认或较低思考深度后重试；未发送生成请求。';
  if (code === 'output_limit') return '模型服务已响应，但在测试输出预算内未完成。请降低思考深度后重试；本次请求可能已产生用量。';
  if (issue.status === 401 && /login required|unauthenticated/i.test(marker)) return '登录已失效，请重新登录后获取模型。';
  if (code === 'credentials_rejected' || issue.status === 401 || /rejected credentials|拒绝了密钥/i.test(marker)) {
    return '模型服务拒绝了凭据，请填写有效的 API Key，并检查所选协议和密钥权限。';
  }
  if (code === 'saved_key_mismatch' || /saved credential is unavailable|new API key or clear_key/i.test(marker)) {
    return '服务地址已改变，无法复用已保存密钥。请重新填写 API Key，或勾选清除旧密钥。';
  }
  if (code === 'timeout' || issue.status === 504 || /timed out/i.test(marker)) return '获取模型超时，请检查服务地址或稍后重试。';
  if (code === 'directory_unsupported' || /directory is unavailable|format is unsupported/i.test(marker)) {
    return '服务未提供可识别的模型目录，请手动选择协议并填写模型名称。';
  }
  if (/invalid request origin|request origin/i.test(marker)) {
    return '请求来源校验失败，请通过当前服务地址打开页面，或检查服务的 External URL 配置。';
  }
  if (issue.status === 403) return '只有管理员可以获取模型或修改模型连接。';
  if (issue.status === 429 || /rate limited/i.test(marker)) return '模型服务请求过于频繁，请稍后重试。';
  if (/base_url|invalid model discovery input|invalid assistant configuration/i.test(marker)) return '请检查服务地址、协议和连接信息。';
  if (/model is required and configuration exceeds/i.test(marker)) return '请检查模型名称和 API Key 的长度，避免输入控制字符。';
  if (/cannot read assistant configuration|cannot protect assistant|cannot save assistant/i.test(marker)) return '暂时无法读取或保存配置，请稍后重试。';
  return '连接模型服务失败，请检查地址、所选协议和 API Key 后重试。';
}
