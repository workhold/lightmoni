import { useEffect, useMemo, useState } from 'react';
import { App, Alert, AutoComplete, Button, Checkbox, Collapse, Form, Input, InputNumber, Modal, Select, Switch, Tag } from '../../shared/ui';
import { api } from '../../shared/api';
import { discoveryInput, ModelDiscovery, type DiscoveryState } from './model-discovery';
import { initialProtocol, modelConnectionError, protocolChoices, protocolLabel, protocolSourceLabel, resolveProtocol } from './model-protocol';
import type { AssistantConfig, ModelDiscoveryResult, ModelProtocolSelection } from './types';

export function ModelSettings({ open, config, onClose, onSaved }: {
  open: boolean; config?: AssistantConfig; onClose: () => void; onSaved: (config: AssistantConfig) => void;
}) {
  const [form] = Form.useForm();
  const { message } = App.useApp();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [discovery, setDiscovery] = useState<DiscoveryState>({ status: 'idle' });
  const base = Form.useWatch('base_url', form) as string | undefined;
  const key = Form.useWatch('api_key', form) as string | undefined;
  const clear = Form.useWatch('clear_key', form) as boolean | undefined;
  const protocol = Form.useWatch('protocol', form) as ModelProtocolSelection | undefined;
  const query = useMemo(() => new ModelDiscovery(
    (input, signal) => api<ModelDiscoveryResult>('/assistant/models', { method: 'POST', body: JSON.stringify(input), signal }),
    state => {
      setDiscovery(state);
      if (state.result && form.getFieldValue('base_url') !== state.result.base_url) {
        form.setFieldValue('base_url', state.result.base_url);
      }
    },
  ), [form]);

  useEffect(() => {
    query.dispose(); setDiscovery({ status: 'idle' }); setError('');
    if (open) form.setFieldsValue({
      base_url: config?.base_url ?? '', protocol: initialProtocol(config), model: config?.model ?? '', api_key: '', clear_key: false,
      enabled: config?.enabled ?? true, max_input_tokens: config?.max_input_tokens ?? 32000,
      max_output_tokens: config?.max_output_tokens ?? 4096, max_steps: config?.max_steps ?? 8,
    });
    else form.setFieldValue('api_key', '');
  }, [open, config, form, query]);

  useEffect(() => {
    query.setInput(open && !saving ? discoveryInput({ base_url: base, api_key: key, clear_key: clear, protocol }, !!config?.has_key) : undefined);
  }, [open, saving, base, key, clear, protocol, config?.has_key, query]);
  useEffect(() => () => query.dispose(), [query]);

  function close() { query.dispose(); onClose(); }
  function refresh() {
    const input = discoveryInput(form.getFieldsValue(), !!config?.has_key);
    if (!input) { void form.validateFields(['base_url', 'protocol']).catch(() => {}); return; }
    query.setInput(input); query.refresh();
  }
  async function save() {
    try {
      setError('');
      const values = await form.validateFields();
      const resolved = resolveProtocol(values.protocol, query.currentResult(discoveryInput(values, !!config?.has_key)));
      if (!resolved.protocol) {
        form.setFields([{ name: 'protocol', errors: [resolved.error ?? '请选择具体 API 协议。'] }]);
        setError(resolved.error ?? '请选择具体 API 协议。'); return;
      }
      setSaving(true); query.dispose(); setDiscovery({ status: 'idle' });
      const saved = await api<AssistantConfig>('/assistant/config', { method: 'PUT', body: JSON.stringify({ ...values, protocol: resolved.protocol }) });
      onSaved(saved); onClose(); void message.success('AI 模型配置已保存');
    } catch (problem) {
      if (!(problem && typeof problem === 'object' && 'errorFields' in problem)) setError(modelConnectionError(problem));
    } finally { setSaving(false); }
  }

  const options = discovery.result?.models.map(model => ({ value: model.id })) ?? [];
  const result = discovery.result;
  const candidates = result?.protocol_options?.map(option => protocolLabel(option)).join(' / ');
  return <Modal open={open} forceRender centered width={600} title="AI 模型连接"
    styles={{ body: { maxHeight: 'calc(100dvh - 220px)', overflowY: 'auto' } }}
    onCancel={close} onOk={() => void save()} confirmLoading={saving} closable={!saving} maskClosable={!saving}
    cancelButtonProps={{ disabled: saving }} okText="保存配置" cancelText="取消">
    <Form form={form} layout="vertical" onValuesChange={(changed, values) => {
      if (['base_url', 'api_key', 'clear_key', 'protocol'].some(field => Object.hasOwn(changed, field))) {
        setError('');
        query.setInput(discoveryInput(values, !!config?.has_key));
      }
    }}>
      <Form.Item name="protocol" label="API 协议" extra="自动识别依据地址与目录格式推荐；也可以直接选择服务实际支持的协议。" rules={[{ required: true, message: '选择 API 协议' }]}>
        <Select options={protocolChoices} disabled={saving} />
      </Form.Item>
      <Form.Item name="base_url" label="API Base URL" extra="支持 API 基地址、服务根地址或完整的生成接口地址。"
        rules={[{ required: true, message: '填写服务地址' }, { validator: (_, value) => !value || discoveryInput({ base_url: value }, false) ? Promise.resolve() : Promise.reject(new Error('填写有效的 HTTP(S) 地址，不含账号、查询参数或片段')) }]}>
        <Input placeholder="https://api.example.com/v1" disabled={saving} />
      </Form.Item>
      <Form.Item name="api_key" label="API Key" extra={config?.has_key ? '已保存密钥；原地址留空可复用，换地址请重新填写或清除旧密钥。' : '支持无需密钥的本地兼容模型服务。'}>
        <Input.Password placeholder={config?.has_key ? '保留原地址的已保存密钥' : '填写 API Key'} autoComplete="new-password" disabled={saving} />
      </Form.Item>
      {config?.has_key && <Form.Item name="clear_key" valuePropName="checked"><Checkbox disabled={saving}>清除已保存密钥</Checkbox></Form.Item>}
      <Button type="primary" size="large" block loading={discovery.status === 'loading'} disabled={saving || !discoveryInput({ base_url: base, protocol }, false)} onClick={refresh}>
        {discovery.status === 'success' ? '刷新模型' : '获取模型'}
      </Button>
      <p role="status">
        {discovery.status === 'idle' && '填写服务地址和有效 API Key 后自动获取模型；无需密钥的服务可留空。'}
        {discovery.status === 'waiting' && '连接信息已更新，即将自动获取模型；也可以点击按钮立即查询。'}
        {discovery.status === 'loading' && '正在获取可用模型并确认目录格式…'}
        {discovery.status === 'error' && '可修改连接信息后重试，或手动选择协议并填写模型名称。'}
        {discovery.status === 'success' && (options.length ? `已获取 ${options.length} 个模型${result?.truncated ? '（列表已截断，可手动输入其他模型）' : ''}。` : '服务返回了空模型列表，请手动填写模型名称。')}
      </p>
      {discovery.status === 'error' && <Alert type="warning" showIcon title={discovery.error} description="获取列表不会保存配置，也不会发起生成请求。" />}
      {result && <Alert style={{ marginBottom: 16 }} type={result.requires_confirmation && protocol === 'auto' ? 'warning' : 'info'} showIcon
        title={result.requires_confirmation && protocol === 'auto' ? '此目录无法区分实际调用协议，请在上方选择具体协议。' : <><Tag color="processing">{protocolLabel(result.protocol)}</Tag>{protocolSourceLabel(result.protocol_source)}</>}
        description={<>{result.requires_confirmation && protocol === 'auto' && <p style={{ margin: '0 0 8px' }}>候选协议：{candidates}。</p>}获取模型列表尚未验证生成或工具调用能力，也不能确定模型的上下文长度。</>} />}
      <Form.Item name="model" label="模型名称"
        extra="从列表选择或直接输入准确名称。自动获取不会替换已填写的模型。" rules={[{ required: true, whitespace: true, message: '选择或填写模型名称' }, { max: 200, message: '模型名称不能超过 200 个字符' }]}>
        <AutoComplete options={options} placeholder="选择模型或手动输入" disabled={saving}
          filterOption={(input, option) => String(option?.value ?? '').toLowerCase().includes(input.toLowerCase())} />
      </Form.Item>
      <Collapse ghost items={[{ key: 'limits', forceRender: true, label: '执行限制', children: <>
        <Form.Item name="max_input_tokens" label="输入上下文预算" extra="用于保守估算并整理历史，请设在模型实际上下文限制以内。" rules={[{ required: true }]}><InputNumber disabled={saving} precision={0} min={4096} max={128000} step={1024} /></Form.Item>
        <Form.Item name="max_output_tokens" label="单次模型输出上限" rules={[{ required: true }]}><InputNumber disabled={saving} precision={0} min={256} max={16384} step={256} /></Form.Item>
        <Form.Item name="max_steps" label="每轮最多执行步数" rules={[{ required: true }]}><InputNumber disabled={saving} precision={0} min={1} max={12} /></Form.Item>
      </> }]} />
      <Form.Item name="enabled" label="启用 AI 助手" valuePropName="checked"><Switch disabled={saving} /></Form.Item>
      {error && <Alert type="error" title={error} showIcon />}
    </Form>
  </Modal>;
}
