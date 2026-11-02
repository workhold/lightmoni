import {useI18n} from '../../shared/i18n';
import { useEffect, useMemo, useRef, useState } from 'react';
import { App, Alert, AutoComplete, Button, Card, Checkbox, Collapse, Form, Input, InputNumber, Modal, Select, Switch, Tag } from '../../shared/ui';
import { api } from '../../shared/api';
import { discoveryInput, ModelDiscovery, type DiscoveryState } from './model-discovery';
import { describeAddressCorrection, type AddressCorrection } from './model-address';
import { initialProtocol, isModelProtocol, modelConnectionError, getProtocolChoices, protocolLabel, protocolSourceLabel, getReasoningEffortChoices, resolveProtocol } from './model-protocol';
import type { AssistantConfig, ModelConnectionTestResult, ModelDiscoveryResult, ModelProtocolSelection } from './types';

export interface ModelSettingsProps {
  /** Whether the modal is visible. Ignored when embedded is true. */
  open?: boolean;
  /** Render the form in the settings page instead of a modal. */
  embedded?: boolean;
  config?: AssistantConfig;
  onClose?: () => void;
  onSaved: (config: AssistantConfig) => void;
  beforeSave?: (config: AssistantConfig) => Promise<boolean> | boolean;
}

export function ModelSettings({ open = false, embedded = false, config, onClose, onSaved, beforeSave }: ModelSettingsProps) {
 const {language,t}=useI18n();

  const protocolChoices=getProtocolChoices(language),reasoningEffortChoices=getReasoningEffortChoices(language);
  const [form] = Form.useForm();
  const { message } = App.useApp();
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState('');
  const [testResult, setTestResult] = useState<{ status: 'success' | 'error'; latency_ms?: number; message?: string }>();
  const testGeneration = useRef(0);
  const testAbort = useRef<AbortController | null>(null);
  const [discovery, setDiscovery] = useState<DiscoveryState>({ status: 'idle' });
  const [addressCorrection, setAddressCorrection] = useState<AddressCorrection>();
  const base = Form.useWatch('base_url', form) as string | undefined;
  const key = Form.useWatch('api_key', form) as string | undefined;
  const clear = Form.useWatch('clear_key', form) as boolean | undefined;
  const protocol = Form.useWatch('protocol', form) as ModelProtocolSelection | undefined;
  const model = Form.useWatch('model', form) as string | undefined;
  const query = useMemo(() => new ModelDiscovery(
    (input, signal) => api<ModelDiscoveryResult>('/assistant/models', { method: 'POST', body: JSON.stringify(input), signal }),
    state => {
      setDiscovery(state);
      if (state.result && form.getFieldValue('base_url') !== state.result.base_url) {
        setAddressCorrection(describeAddressCorrection(form.getFieldValue('base_url'), state.result.base_url));
        testAbort.current?.abort(); testAbort.current = null; setTestResult(undefined); setTesting(false); testGeneration.current++;
        form.setFieldValue('base_url', state.result.base_url);
      }
    },
  ), [form]);

  const visible = embedded || open;

  useEffect(() => {
    query.dispose(); testAbort.current?.abort(); testAbort.current = null; setDiscovery({ status: 'idle' }); setAddressCorrection(undefined); setError(''); setTestResult(undefined); setTesting(false); testGeneration.current++;
    if (visible) form.setFieldsValue({
      base_url: config?.base_url ?? '', protocol: initialProtocol(config), model: config?.model ?? '', api_key: '', clear_key: false,
      enabled: config?.enabled ?? true, max_input_tokens: config?.max_input_tokens ?? 32000,
      max_output_tokens: config?.max_output_tokens ?? 4096, max_steps: config?.max_steps ?? 8,
      reasoning_effort: config?.reasoning_effort ?? 'provider-default',
    });
    else form.setFieldValue('api_key', '');
  }, [visible, config, form, query]);

  useEffect(() => {
    query.setInput(visible && !saving ? discoveryInput({ base_url: base, api_key: key, clear_key: clear, protocol }, !!config?.has_key) : undefined);
  }, [visible, saving, base, key, clear, protocol, config?.has_key, query]);
  useEffect(() => () => { query.dispose(); testAbort.current?.abort(); testAbort.current = null; testGeneration.current++; }, [query]);

  function close() { query.dispose(); testAbort.current?.abort(); testAbort.current = null; setAddressCorrection(undefined); setTesting(false); testGeneration.current++; onClose?.(); }
  function refresh() {
    const input = discoveryInput(form.getFieldsValue(), !!config?.has_key);
    if (!input) { void form.validateFields(['base_url', 'protocol']).catch(() => {}); return; }
    query.setInput(input); query.refresh();
  }
  async function save() {
    try {
      setError('');
      const values = await form.validateFields();
      const resolved = resolveProtocol(values.protocol, query.currentResult(discoveryInput(values, !!config?.has_key)),language);
      if (!resolved.protocol) {
        form.setFields([{ name: 'protocol', errors: [resolved.error ?? t("请选择具体 API 协议。","Select a specific API protocol.")] }]);
        setError(resolved.error ?? t("请选择具体 API 协议。","Select a specific API protocol.")); return;
      }
      const payload = { ...values, protocol: resolved.protocol } as AssistantConfig;
      if (beforeSave && !(await beforeSave(payload))) return;
      setSaving(true); testAbort.current?.abort(); testAbort.current = null; setTestResult(undefined); testGeneration.current++; query.dispose(); setDiscovery({ status: 'idle' });
      const saved = await api<AssistantConfig>('/assistant/config', { method: 'PUT', body: JSON.stringify(payload) });
      onSaved(saved); if (!embedded) onClose?.(); void message.success(t("AI 模型配置已保存","AI model configuration saved"));
    } catch (problem) {
      if (!(problem && typeof problem === 'object' && 'errorFields' in problem)) setError(modelConnectionError(problem,language));
    } finally { setSaving(false); }
  }

  async function testConnection() {
    const generation = ++testGeneration.current;
    try {
      setError(''); setTestResult(undefined);
      const checked = await form.validateFields(['base_url', 'protocol', 'model']);
      const values = { ...form.getFieldsValue(), ...checked } as Record<string, unknown> & { base_url?: string; protocol?: ModelProtocolSelection; model?: string; api_key?: string; clear_key?: boolean; reasoning_effort?: string };
      const resolved = resolveProtocol(values.protocol ?? 'auto', query.currentResult(discoveryInput(values, !!config?.has_key)),language);
      if (!resolved.protocol) {
        const message = resolved.error ?? t("测试连接前请获取模型以识别协议，或手动选择具体 API 协议。","Fetch models to detect the protocol or choose a specific protocol before testing.");
        form.setFields([{ name: 'protocol', errors: [message] }]); setError(message); return;
      }
      const modelName = typeof values.model === 'string' ? values.model.trim() : '';
      if (!modelName) {
        const message = t("测试连接前请填写模型名称。","Enter a model name before testing the connection.");
        form.setFields([{ name: 'model', errors: [message] }]); setError(message); return;
      }
      const input = discoveryInput(values, !!config?.has_key);
      if (!input) {
        const message = t("请检查服务地址和连接信息。","Check the service URL and connection details.");
        setError(message); return;
      }
      setTesting(true);
      const abort = new AbortController();
      testAbort.current = abort;
      const result = await api<ModelConnectionTestResult>('/assistant/test-connection', {
        method: 'POST',
        body: JSON.stringify({ base_url: input.base_url, api_key: input.api_key, use_saved_key: input.use_saved_key, protocol: resolved.protocol, model: modelName, reasoning_effort: values.reasoning_effort }),
        signal: abort.signal,
      });
      if (generation !== testGeneration.current) return;
      if (form.getFieldValue('base_url') !== result.base_url) {
        // Cancel any directory request for the old address before adopting the
        // tested destination, so a late response cannot undo this correction.
        query.setInput(discoveryInput({ ...values, base_url: result.base_url }, !!config?.has_key));
        setAddressCorrection(describeAddressCorrection(form.getFieldValue('base_url'), result.base_url));
        form.setFieldValue('base_url', result.base_url);
      }
      setTestResult({ status: 'success', latency_ms: result.latency_ms });
      void message.success(t("连接测试成功","Connection test succeeded"));
    } catch (problem) {
      if (generation !== testGeneration.current) return;
      if (problem && typeof problem === 'object' && 'errorFields' in problem) return;
      setTestResult({ status: 'error', message: modelConnectionError(problem,language) });
    } finally {
      if (generation === testGeneration.current) { setTesting(false); testAbort.current = null; }
    }
  }

  const options = discovery.result?.models.map(model => ({ value: model.id })) ?? [];
  const result = discovery.result;
  const candidates = result?.protocol_options?.map(option => protocolLabel(option,language)).join(' / ');
  const displayedProtocol = result && (isModelProtocol(protocol) ? protocol : result.protocol);
  const permissionDenied = discovery.error === modelConnectionError({status:403});
  const discoveryError = language==='en-US' ? discovery.error_english??discovery.error : discovery.error;
  const correctionReason=addressCorrection&&describeAddressCorrection(addressCorrection.original,addressCorrection.corrected,language)?.reason;
  const modelHint = options.length > 0
    ? t(`已发现 ${options.length} 个模型，可从下拉列表选择，也可以手动输入。`,`Found ${options.length} models. Select one from the list or enter a name manually.`)
    : discovery.status === 'success'
      ? t("目录为空，请手动填写模型名称。","The directory is empty. Enter a model name manually.")
      : discovery.status === 'error'
        ? permissionDenied
          ? t("当前账号没有模型配置权限，请切换管理员账号后重试。","This account cannot configure models. Sign in as an administrator and retry.")
          : t("未能获取模型目录，请手动填写模型名称。","Could not fetch the model directory. Enter a model name manually.")
        : t("获取模型后可从下拉列表选择，也可以手动输入。","Fetch models to select one from the list, or enter a name manually.");
  const testProtocol = resolveProtocol(protocol ?? 'auto', query.currentResult(discoveryInput({ base_url: base, api_key: key, clear_key: clear, protocol }, !!config?.has_key))).protocol;
  const canTest = !saving && !testing && !!testProtocol && !!model?.trim() && !!discoveryInput({ base_url: base, protocol }, false);
  const formContent = <Form form={form} layout="vertical" onValuesChange={(changed, values) => {
      if (['base_url', 'api_key', 'clear_key', 'protocol', 'model', 'reasoning_effort'].some(field => Object.hasOwn(changed, field))) {
        setError('');
        testAbort.current?.abort(); testAbort.current = null; setTestResult(undefined); setTesting(false); testGeneration.current++;
      }
      if (['base_url', 'api_key', 'clear_key', 'protocol'].some(field => Object.hasOwn(changed, field))) {
        setAddressCorrection(undefined);
        query.setInput(discoveryInput(values, !!config?.has_key));
      }
    }}>
      <Form.Item name="protocol" label={t("API 协议","API protocol")} extra={t("自动识别依据地址与目录格式推荐；也可以直接选择服务实际支持的协议。","Automatic detection uses the URL and directory format. You can also select a protocol supported by the service.")} rules={[{ required: true, message: t("选择 API 协议","Select an API protocol") }]}>
        <Select options={protocolChoices} disabled={saving} />
      </Form.Item>
      <Form.Item name="base_url" label="API Base URL" extra={t("支持 API 基地址、服务根地址或完整接口地址；修正成功后，此处显示实际使用的地址。","Enter an API base URL, service root or complete endpoint. After correction, this field shows the actual URL used.")}
        rules={[{ required: true, message: t("填写服务地址","Enter the service URL") }, { validator: (_, value) => !value || discoveryInput({ base_url: value }, false) ? Promise.resolve() : Promise.reject(new Error(t("填写有效的 HTTP(S) 地址，不含账号、查询参数或片段","Enter a valid HTTP(S) URL without credentials, query parameters or fragments"))) }]}>
        <Input placeholder="https://api.example.com/v1" disabled={saving} />
      </Form.Item>
      {addressCorrection && <Alert className="lm-model-address-correction" style={{ marginBottom: 16 }} type="info" showIcon title={t("已修正 Base URL","Base URL corrected")}
        description={<div style={{ overflowWrap: 'anywhere' }}>
          <div>{correctionReason}</div>
          <div>{t("原地址：","Original URL: ")}{addressCorrection.original}</div>
          <div>{t("修正后：","Corrected URL: ")}{addressCorrection.corrected}</div>
        </div>} />}
      <Form.Item name="api_key" label="API Key" extra={config?.has_key ? t("已保存密钥；原地址留空可复用，换地址请重新填写或清除旧密钥。","A key is saved. Leave blank to reuse it for the same URL; enter a new key or clear it when changing the URL.") : t("支持无需密钥的本地兼容模型服务。","Local compatible model services without keys are supported.")}>
        <Input.Password placeholder={config?.has_key ? t("保留原地址的已保存密钥","Keep the saved key for the original URL") : t("填写 API Key","Enter an API key")} autoComplete="new-password" disabled={saving} />
      </Form.Item>
      {config?.has_key && <Form.Item name="clear_key" valuePropName="checked"><Checkbox disabled={saving}>{t("清除已保存密钥","Clear saved key")}</Checkbox></Form.Item>}
      <Button type="primary" size="large" block loading={discovery.status === 'loading'} disabled={saving || testing || !discoveryInput({ base_url: base, protocol }, false)} onClick={refresh}>
        {discovery.status === 'success' ? t("刷新模型","Refresh models") : t("获取模型","Fetch models")}
      </Button>
      <p role="status">
        {discovery.status === 'idle' && t("填写服务地址和有效 API Key 后自动获取模型；无需密钥的服务可留空。","Models are fetched automatically after entering a service URL and valid API key. Leave the key blank for services that do not require one.")}
        {discovery.status === 'waiting' && t("连接信息已更新，即将自动获取模型；也可以点击按钮立即查询。","Connection details updated. Models will be fetched automatically; click the button to fetch now.")}
        {discovery.status === 'loading' && t("正在获取可用模型并确认目录格式…","Fetching available models and checking the directory format…")}
        {discovery.status === 'error' && (permissionDenied
          ? t("当前账号没有权限获取模型目录或修改模型连接，请切换管理员账号后重试。","This account cannot fetch model directories or edit model connections. Sign in as an administrator and retry.")
          : t("可修改连接信息后重试，或手动选择协议并填写模型名称。","Update connection details and retry, or select a protocol and enter a model name manually."))}
        {discovery.status === 'success' && (options.length ? t(`已获取 ${options.length} 个模型${result?.truncated ? '（列表已截断，可手动输入其他模型）' : ''}。`,`Fetched ${options.length} models${result?.truncated ? ' (list truncated; enter other models manually)' : ''}.`) : t("服务返回了空模型列表，请手动填写模型名称。","The service returned an empty model list. Enter a model name manually."))}
      </p>
      {discovery.status === 'error' && <Alert type="warning" showIcon title={discoveryError} description={t("获取列表不会保存配置，也不会发起生成请求。","Fetching the list does not save configuration or send a generation request.")} />}
      {result && <Alert style={{ marginBottom: 16 }} type={result.requires_confirmation && protocol === 'auto' ? 'warning' : 'info'} showIcon
        title={result.requires_confirmation && protocol === 'auto' ? t("已识别为 OpenAI 兼容目录，但还需选择具体调用协议。","An OpenAI-compatible directory was detected. Select the specific API protocol to use.") : <><Tag color="processing">{displayedProtocol ? protocolLabel(displayedProtocol,language) : t("未知协议","Unknown protocol")}</Tag>{protocolSourceLabel(result.protocol_source,language)}</>}
        description={<>{result.requires_confirmation && protocol === 'auto' && <p style={{ margin: '0 0 8px' }}>{t("模型目录只返回模型 ID，无法判断 Chat Completions 还是 Responses；候选协议：","The directory only returns model IDs and cannot distinguish Chat Completions from Responses. Candidate protocols: ")}{candidates}{t("。请按服务实际支持的接口选择后再保存或测试连接。",". Select a protocol supported by the service before saving or testing.")}</p>}{t("目录只提供模型名称，不验证生成、工具调用或上下文上限；测试连接才会验证一次最小生成请求。","The directory provides model names; it does not verify generation, tool calls or context limits. Test connection sends a minimal generation request.")}</>} />}
      <Form.Item name="model" label={t("模型名称","Model name")}
        extra={modelHint} rules={[{ required: true, whitespace: true, message: t("选择或填写模型名称","Select or enter a model name") }, { max: 200, message: t("模型名称不能超过 200 个字符","Model name must be 200 characters or fewer") }]}>
        <AutoComplete options={options} placeholder={t("选择模型或手动输入","Select a model or enter a name")} disabled={saving}
          filterOption={(input, option) => String(option?.value ?? '').toLowerCase().includes(input.toLowerCase())} />
      </Form.Item>
      <div style={{ marginBottom: 16 }}>
        <Button type="default" block loading={testing} disabled={!canTest} onClick={() => void testConnection()}>{t("测试连接","Test connection")}</Button>
        <small style={{ display: 'block', marginTop: 8, color: 'var(--lm-muted)' }}>{testProtocol ? t(`将使用 ${protocolLabel(testProtocol)} 测试。`,`Testing with ${protocolLabel(testProtocol,language)}. `) : t("选择模型并确定协议后可用；自动识别有歧义时请手动选择协议。","Select a model and confirm a protocol first. Choose a protocol manually if detection is ambiguous.")}{t("测试会发送一次总输出预算最多 256 Token 的真实请求，思考配置无法满足该预算时会提示；可能产生少量供应商费用，用量会计入模型管理。","The test sends a real request with a total output budget of up to 256 tokens. You will be notified if the reasoning setting exceeds the budget. Provider charges may apply and usage is recorded in model management.")}</small>
      </div>
      {testResult?.status === 'success' && <Alert type="success" showIcon title={t(`连接测试成功${testResult.latency_ms === undefined ? '' : ` · ${testResult.latency_ms} ms`}`,`Connection test succeeded${testResult.latency_ms === undefined ? '' : ` · ${testResult.latency_ms} ms`}`)} description={t("已完成一次最小请求。请注意，真实模型调用可能产生供应商费用。","A minimal request completed. Real model calls may incur provider charges.")} />}
      {testResult?.status === 'error' && <Alert type="error" showIcon title={t("连接测试失败","Connection test failed")} description={testResult.message} />}
      <Collapse ghost items={[{ key: 'limits', forceRender: true, label: t("执行限制","Execution limits"), children: <>
        <Form.Item name="max_input_tokens" label={t("输入上下文预算","Input context budget")} extra={t("用于保守估算并整理历史，请设在模型实际上下文限制以内。","Used to estimate and summarize history conservatively. Keep this below the model's actual context limit.")} rules={[{ required: true }]}><InputNumber disabled={saving} precision={0} min={4096} max={128000} step={1024} /></Form.Item>
        <Form.Item name="max_output_tokens" label={t("单次模型输出上限","Maximum output per model call")} rules={[{ required: true }]}><InputNumber disabled={saving} precision={0} min={256} max={16384} step={256} /></Form.Item>
        <Form.Item name="max_steps" label={t("每轮最多执行步数","Maximum steps per turn")} rules={[{ required: true }]}><InputNumber disabled={saving} precision={0} min={1} max={12} /></Form.Item>
        <Form.Item name="reasoning_effort" label={t("模型思考深度","Reasoning effort")} extra={t("不同模型和服务商支持范围不同；默认跟随模型，不会额外发送推理参数。选择具体级别后由 SDK 尽力映射，实际是否支持请用测试连接验证。","Support varies by model and provider. The default follows the model without extra reasoning parameters. The SDK maps specific levels where possible; use Test connection to verify support.")} rules={[{ required: true, message: t("选择模型思考深度","Select reasoning effort") }]}><Select options={reasoningEffortChoices} disabled={saving} /></Form.Item>
      </> }]} />
      <Form.Item name="enabled" label={t("启用 AI 助手","Enable AI assistant")} valuePropName="checked"><Switch disabled={saving} /></Form.Item>
      {error && <Alert type="error" title={error} showIcon />}
    </Form>;

  if (embedded) {
    return <Card title={t("AI 模型连接","AI model connection")}>
      {formContent}
      <Button type="primary" loading={saving} disabled={testing} onClick={() => void save()}>{t("保存配置","Save configuration")}</Button>
    </Card>;
  }

  return <Modal open={open} forceRender centered width={600} title={t("AI 模型连接","AI model connection")}
    styles={{ body: { maxHeight: 'calc(100dvh - 220px)', overflowY: 'auto' } }}
    onCancel={close} onOk={() => void save()} confirmLoading={saving} closable={!saving} maskClosable={!saving}
    cancelButtonProps={{ disabled: saving || testing }} okButtonProps={{ disabled: testing }} okText={t("保存配置","Save configuration")} cancelText={t("取消","Cancel")}>
    {formContent}
  </Modal>;
}
