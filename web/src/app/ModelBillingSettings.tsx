import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, App, Button, Form, InputNumber, Select, Spin, Tag } from '../shared/ui';
import { api, ApiError } from '../shared/api';
import { billingIsDirty, billingPayload, modelIdentity, validPrice, type ModelBilling, type ModelIdentity } from './model-management';

type BillingFields = Pick<ModelBilling, 'currency' | 'input_price_per_million' | 'output_price_per_million'>;
interface BillingProps {
  identity: string;
  onIdentityLoaded: (value: ModelIdentity) => Promise<void>;
  onIdentityStale: () => void;
  onDirtyChange: (dirty: boolean) => void;
}

export default function ModelBillingSettings({ identity, onIdentityLoaded, onIdentityStale, onDirtyChange }: BillingProps) {
  const [form] = Form.useForm<BillingFields>();
  const { message, modal } = App.useApp();
  const [billing, setBilling] = useState<ModelBilling>();
  const billingRef = useRef<ModelBilling | undefined>(undefined);
  const loadingIdentity = useRef<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const [dirty, setDirty] = useState(false);
  const generation = useRef(0);
  const loadAbort = useRef<AbortController | undefined>(undefined);
  const saveAbort = useRef<AbortController | undefined>(undefined);

  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);

  const load = useCallback(async () => {
    const version = ++generation.current;
    loadAbort.current?.abort(); saveAbort.current?.abort(); saveAbort.current = undefined;
    const abort = new AbortController(); loadAbort.current = abort;
    setLoading(true); setSaving(false); setError('');
    try {
      const value = await api<ModelBilling>('/assistant/billing', { signal: abort.signal });
      if (abort.signal.aborted || version !== generation.current) return;
      // The parent's identity update must not abort this in-flight reload.
      // Keep the old form intact until both endpoints agree on the identity.
      loadingIdentity.current = modelIdentity(value);
      try { await onIdentityLoaded(value); }
      catch (problem) { if (!abort.signal.aborted && version === generation.current) setStale(true); throw problem; }
      if (abort.signal.aborted || version !== generation.current) return;
      billingRef.current = value;
      setBilling(value); setDirty(false); setStale(false);
      form.setFieldsValue({ currency: value.currency, input_price_per_million: value.input_price_per_million, output_price_per_million: value.output_price_per_million });
    } catch {
      if (!abort.signal.aborted && version === generation.current) setError('无法加载模型单价或同步连接，请稍后重试；未保存的修改已保留。');
    } finally {
      if (!abort.signal.aborted && version === generation.current) { setLoading(false); loadAbort.current = undefined; loadingIdentity.current = undefined; }
    }
  }, [form, onIdentityLoaded]);

  useEffect(() => {
    // Saving limits on the same model does not reload its price form. A new
    // identity is accepted only after the parent's connection-change guard.
    if (billingRef.current && modelIdentity(billingRef.current) === identity) return;
    if (loadingIdentity.current === identity) return;
    void load();
  }, [identity, load]);
  useEffect(() => () => { loadAbort.current?.abort(); saveAbort.current?.abort(); generation.current++; }, []);

  async function reload() {
    if (dirty && !await modal.confirm({
      title: '放弃未保存的单价修改？',
      content: '重新加载将用服务器上的单价替换当前草稿。连接已变化时，旧草稿不会用于新模型。',
      okText: '放弃修改并重新加载', cancelText: '继续编辑',
    })) return;
    await load();
  }

  async function save() {
    if (!billing || stale || loading || saving || modelIdentity(billing) !== identity) return;
    const version = generation.current;
    try {
      const values = await form.validateFields();
      if (version !== generation.current) return;
      setError(''); setSaving(true);
      const abort = new AbortController(); saveAbort.current = abort;
      const result = await api<ModelBilling>('/assistant/billing', { method: 'PUT', body: JSON.stringify(billingPayload(billing, values)), signal: abort.signal });
      if (version !== generation.current || abort.signal.aborted) return;
      billingRef.current = result;
      setBilling(result); setDirty(false); form.setFieldsValue(result);
      void message.success('模型单价已保存');
    } catch (problem) {
      if (version !== generation.current || (problem && typeof problem === 'object' && 'errorFields' in problem)) return;
      if (problem instanceof ApiError && problem.status === 409) {
        setStale(true); onIdentityStale(); setError('模型连接已更新，草稿已保留。请重新加载单价，同步当前连接后再保存。');
      } else setError('模型单价保存失败，填写的内容已保留，请重试。');
    } finally {
      if (version === generation.current) { setSaving(false); saveAbort.current = undefined; }
    }
  }

  const priceRules = [{ validator: (_: unknown, value: unknown) => validPrice(value) ? Promise.resolve() : Promise.reject(new Error('填写 0 至 1,000,000,000 之间的有效单价，或留空')) }];
  const configured = !!billing?.base_url && !!billing?.model;
  const identityChanged = !!billing && modelIdentity(billing) !== identity;
  return <section className="lm-surface lm-model-billing" aria-labelledby="model-billing-title">
    <div className="lm-settings-section-head">
      <div><h2 id="model-billing-title">模型计费 {dirty && <Tag color="warning">有未保存修改</Tag>}</h2><p>管理员填写当前模型的输入和输出单价，以每百万 Token 为单位估算费用。</p></div>
      <Button onClick={() => void reload()} disabled={loading || saving}>重新加载单价</Button>
    </div>
    {loading && <div className="lm-model-inline-loading" role="status"><Spin size="small" />正在加载模型单价…</div>}
    {error && <Alert className="lm-model-section-alert" type="error" showIcon title={error} action={!billing ? <Button onClick={() => void reload()}>重试加载</Button> : undefined} />}
    {billing && <>
      <p className="lm-model-price-identity">{identityChanged ? '原连接单价（待同步）：' : '当前模型：'}<strong>{billing.model || '尚未配置'}</strong><span>{billing.base_url}</span></p>
      {!configured && <Alert className="lm-model-section-alert" type="info" showIcon title="请先完成模型连接配置，再设置模型单价。" />}
      <Form form={form} layout="vertical" onValuesChange={(_, values) => setDirty(billingIsDirty(billing, values))} onFinish={() => void save()} disabled={loading || saving || !configured || stale || identityChanged}>
        <div className="lm-model-price-fields">
          <Form.Item name="currency" label="计费币种" rules={[{ required: true, message: '选择计费币种' }]}>
            <Select options={[{ value: 'CNY', label: 'CNY · 人民币' }, { value: 'USD', label: 'USD · 美元' }]} />
          </Form.Item>
          <Form.Item name="input_price_per_million" label="输入单价 / 百万 Token" extra="留空为未配置，0 表示免费。" rules={priceRules}>
            <InputNumber min={0} max={1e9} step={0.1} placeholder="未配置" />
          </Form.Item>
          <Form.Item name="output_price_per_million" label="输出单价 / 百万 Token" extra="留空为未配置，0 表示免费。" rules={priceRules}>
            <InputNumber min={0} max={1e9} step={0.1} placeholder="未配置" />
          </Form.Item>
        </div>
        <Button type="primary" htmlType="submit" loading={saving}>保存单价</Button>
      </Form>
      <p className="lm-settings-hint lm-model-billing-note">费用为估算值，非供应商账单。每轮助手和连接测试使用开始时的单价，修改单价不会重算历史费用；缓存、推理 Token 与供应商折扣可能影响实际账单。</p>
    </>}
  </section>;
}
