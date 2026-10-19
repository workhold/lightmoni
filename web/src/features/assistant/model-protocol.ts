import type {Language} from '../../shared/i18n';
import {translator} from '../alerts/translation.ts';
import type { AssistantConfig, ModelDiscoveryResult, ModelProtocol, ModelProtocolSelection, ReasoningEffort } from './types';

export function getProtocolChoices(language:Language='zh-CN'): { value: ModelProtocolSelection; label: string }[]{const t=translator(language);return [
  { value: 'auto', label: t("自动识别","Automatic detection") },
  { value: 'openai-chat-completions', label: t("OpenAI 兼容 · Chat Completions","OpenAI-compatible · Chat Completions") },
  { value: 'openai-responses', label: 'OpenAI · Responses' },
  { value: 'anthropic-messages', label: 'Anthropic · Messages' },
  { value: 'google-generative-ai', label: t("Google Gemini · 原生协议","Google Gemini · Native API") },
];}
export const protocolChoices=getProtocolChoices();

export function getReasoningEffortChoices(language:Language='zh-CN'): { value: ReasoningEffort; label: string }[]{const t=translator(language);return [
  { value: 'provider-default', label: t("跟随模型（自动）","Model default (automatic)") },
  { value: 'none', label: t("关闭思考","No reasoning") },
  { value: 'minimal', label: t("最小","Minimal") },
  { value: 'low', label: t("低","Low") },
  { value: 'medium', label: t("中","Medium") },
  { value: 'high', label: t("高","High") },
  { value: 'xhigh', label: t("极高","Extra high") },
];}
export const reasoningEffortChoices=getReasoningEffortChoices();

export function isModelProtocol(value: unknown): value is ModelProtocol {
  return protocolChoices.some(option => option.value !== 'auto' && option.value === value);
}

export function protocolLabel(protocol: ModelProtocolSelection, language:Language='zh-CN'): string {
  const t=translator(language);
  return getProtocolChoices(language).find(option => option.value === protocol)?.label ?? t("未知协议","Unknown protocol");
}

export function initialProtocol(config?: Pick<AssistantConfig, 'base_url' | 'protocol'>): ModelProtocolSelection {
  if (!config?.base_url?.trim()) return 'auto';
  return isModelProtocol(config.protocol) ? config.protocol : 'openai-chat-completions';
}

// Only a current, unambiguous directory recommendation can resolve "auto".
// A concrete choice remains usable when a provider has no model directory.
export function resolveProtocol(selected: ModelProtocolSelection, result?: ModelDiscoveryResult, language:Language='zh-CN'): { protocol?: ModelProtocol; error?: string } {
  const t=translator(language);
  if (isModelProtocol(selected)) return { protocol: selected };
  if (selected !== 'auto') return { error: t("请选择支持的 API 协议。","Select a supported API protocol.") };
  if (!result) return { error: t("请先获取模型以识别协议，或手动选择 API 协议后保存。","Fetch models to detect the protocol, or select an API protocol manually before saving.") };
  if (result.requires_confirmation !== false) return { error: t("此模型目录无法区分实际调用方式，请选择具体 API 协议后保存。","The directory cannot distinguish API protocols. Select a specific protocol before saving.") };
  if (!isModelProtocol(result.protocol)) return { error: t("未识别出支持的协议，请手动选择 API 协议。","No supported protocol was detected. Select an API protocol manually.") };
  return { protocol: result.protocol };
}

export function protocolSourceLabel(source: string, language:Language='zh-CN'): string {
 const t=translator(language);
  switch (source) {
    case 'official-host': return t("官方服务地址","Official service host");
    case 'endpoint-path': return t("完整接口地址","Complete endpoint URL");
    case 'catalog': return t("模型目录格式","Model directory format");
    case 'manual': return t("手动选择","Manual selection");
    case 'default': return t("服务默认方式","Service default");
    default: return t("服务返回的信息","Information returned by the service");
  }
}

// Provider responses and arbitrary exception text never become UI messages.
// Match only fixed server codes or legacy safe error markers.
export function modelConnectionError(problem: unknown, language:Language='zh-CN'): string {
 const t=translator(language);
  const issue = problem && typeof problem === 'object' ? problem as { status?: number; details?: { code?: unknown }; message?: unknown } : {};
  const code = issue.details?.code;
  const marker = typeof issue.message === 'string' ? issue.message : '';
  if (code === 'test_budget_exceeded') return t("当前思考深度超出连接测试的 256 Token 总输出预算。请改用模型默认或较低思考深度后重试；未发送生成请求。","The reasoning level exceeds the test's 256-token output budget. Choose the model default or a lower level and retry. No generation request was sent.");
  if (code === 'output_limit') return t("模型服务已响应，但在测试输出预算内未完成。请降低思考深度后重试；本次请求可能已产生用量。","The model service responded but did not complete within the test output budget. Lower reasoning effort and retry. This request may have incurred usage.");
  if (issue.status === 401 && /login required|unauthenticated/i.test(marker)) return t("登录已失效，请重新登录后获取模型。","Your session expired. Sign in again before fetching models.");
  if (code === 'credentials_rejected' || issue.status === 401 || /rejected credentials|拒绝了密钥/i.test(marker)) {
    return t("模型服务拒绝了凭据，请填写有效的 API Key，并检查所选协议和密钥权限。","The model service rejected the credentials. Enter a valid API key and check the protocol and key permissions.");
  }
  if (code === 'saved_key_mismatch' || /saved credential is unavailable|new API key or clear_key/i.test(marker)) {
    return t("服务地址已改变，无法复用已保存密钥。请重新填写 API Key，或勾选清除旧密钥。","The service URL changed, so the saved key cannot be reused. Enter a new API key or clear the saved key.");
  }
  if (code === 'timeout' || issue.status === 504 || /timed out/i.test(marker)) return t("获取模型超时，请检查服务地址或稍后重试。","Fetching models timed out. Check the service URL or retry later.");
  if (code === 'directory_unsupported' || /directory is unavailable|format is unsupported/i.test(marker)) {
    return t("服务未提供可识别的模型目录，请手动选择协议并填写模型名称。","The service has no recognizable model directory. Select a protocol and enter a model name manually.");
  }
  if (/invalid request origin|request origin/i.test(marker)) {
    return t("请求来源校验失败，请通过当前服务地址打开页面，或检查服务的 External URL 配置。","Request origin validation failed. Open the page using the current service URL or check its External URL configuration.");
  }
  if (issue.status === 403) return t("只有管理员可以获取模型或修改模型连接。","Only administrators can fetch models or change model connections.");
  if (issue.status === 429 || /rate limited/i.test(marker)) return t("模型服务请求过于频繁，请稍后重试。","The model service is rate limited. Retry later.");
  if (/base_url|invalid model discovery input|invalid assistant configuration/i.test(marker)) return t("请检查服务地址、协议和连接信息。","Check the service URL, protocol and connection details.");
  if (/model is required and configuration exceeds/i.test(marker)) return t("请检查模型名称和 API Key 的长度，避免输入控制字符。","Check model name and API key lengths, and remove control characters.");
  if (/cannot read assistant configuration|cannot protect assistant|cannot save assistant/i.test(marker)) return t("暂时无法读取或保存配置，请稍后重试。","Could not read or save configuration. Retry later.");
  return t("连接模型服务失败，请检查地址、所选协议和 API Key 后重试。","Could not connect to the model service. Check the URL, protocol and API key, then retry.");
}
