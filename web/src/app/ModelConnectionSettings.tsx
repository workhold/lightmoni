import {useI18n} from '../shared/i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, App, Button, Descriptions, Spin, Tag } from '../shared/ui';
import { api } from '../shared/api';
import { ModelSettings } from '../features/assistant/ModelSettings';
import type { AssistantConfig } from '../features/assistant/types';
import { protocolLabel } from '../features/assistant/model-protocol';
import ModelBillingSettings from './ModelBillingSettings';
import ModelUsageStats from './ModelUsageStats';
import { modelIdentity, type ModelIdentity } from './model-management';

export default function ModelConnectionSettings() {
 const {t,language:uiLanguage}=useI18n();

  const { modal } = App.useApp();
  const [config, setConfig] = useState<AssistantConfig>();
  const currentConfig = useRef<AssistantConfig | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const [billingDirty, setBillingDirty] = useState(false);
  const [usageRevision, setUsageRevision] = useState(0);
  const loadVersion = useRef(0);

  const acceptConfig = useCallback((value: AssistantConfig) => {
    currentConfig.current = value; setConfig(value); setStale(false); setError('');
  }, []);

  const load = useCallback(async (expected?: ModelIdentity) => {
    const version = ++loadVersion.current;
    setLoading(true); setError('');
    try {
      const value = await api<AssistantConfig>('/assistant/config');
      if (version !== loadVersion.current) throw Error('stale configuration response');
      if (expected && modelIdentity(value) !== modelIdentity(expected)) {
        setStale(true); throw Error('model connection changed during reload');
      }
      acceptConfig(value);
    } catch (problem) {
      if (version === loadVersion.current) setError(t("无法同步模型连接，请重新加载后再编辑。","Unable to sync the model connection. Reload before editing."));
      throw problem;
    } finally { if (version === loadVersion.current) setLoading(false); }
  }, [acceptConfig]);

  useEffect(() => { void load().catch(() => {}); return () => { loadVersion.current++; }; }, [load]);

  const syncIdentity = useCallback(async (identity: ModelIdentity) => {
    if (modelIdentity(currentConfig.current) === modelIdentity(identity)) return;
    setStale(true);
    await load(identity);
  }, [load]);

  async function beforeSave(next: ModelIdentity) {
    if (!billingDirty || modelIdentity(next) === modelIdentity(currentConfig.current)) return true;
    return await modal.confirm({
      title: t("更换模型连接并放弃未保存单价？","Change the model connection and discard unsaved prices?"),
      content: t("当前单价还有未保存的修改。更换模型后将加载新连接的单价，旧单价草稿不会用于新模型。","There are unsaved price changes. Changing the model loads prices for the new connection. The old draft will not apply to the new model."),
      okText: t("更换连接并放弃单价修改","Change connection and discard prices"), cancelText: t("返回继续编辑","Return to editing"),
    });
  }

  return <div className="lm-model-management">
    <section className="lm-surface lm-model-settings" aria-labelledby="model-connection-title">
      <div className="lm-settings-section-head">
        <div><h2 id="model-connection-title">{t("模型连接","Model connection")}</h2><p>{t("配置 AI 助手使用的模型服务、密钥与执行限制。测试连接会产生并记录用量。","Configure the AI assistant's model service, API key, and execution limits. Connection tests generate and record usage.")}</p></div>
        <Button type="primary" disabled={loading || !config || stale || !!error} onClick={() => setOpen(true)}>{config?.base_url ? t("编辑模型配置","Edit model settings") : t("配置模型","Configure model")}</Button>
      </div>
      {loading && <Spin aria-label={t("正在同步模型连接","Syncing model connection")} />}
      {error && <Alert className="lm-model-section-alert" type="error" title={error} action={<Button onClick={() => void load().catch(() => {})}>{t("重新加载","Reload")}</Button>} />}
      {stale && !loading && !error && <Alert className="lm-model-section-alert" type="warning" showIcon title={t("模型连接已变化，请重新加载单价以同步当前连接后再编辑。","The model connection changed. Reload prices to sync the current connection before editing.")} />}
      {config && <Descriptions column={1} items={[
        { key: 'status', label: t("状态","Status"), children: <Tag color={config.enabled ? 'success' : 'default'}>{config.enabled ? t("已启用","Enabled") : t("未启用","Disabled")}</Tag> },
        { key: 'address', label: t("服务地址","Service URL"), children: config.base_url || t("尚未配置","Not configured") },
        { key: 'protocol', label: t("API 协议","API protocol"), children: config.protocol ? protocolLabel(config.protocol,uiLanguage) : t("尚未配置","Not configured") },
        { key: 'model', label: t("模型名称","Model name"), children: config.model || t("尚未配置","Not configured") },
        { key: 'key', label: 'API Key', children: config.has_key ? t("已保存","Saved") : t("未设置","Not set") },
      ]} />}
      <ModelSettings open={open} config={config} beforeSave={beforeSave} onClose={() => { setOpen(false); setUsageRevision(value => value + 1); }} onSaved={acceptConfig} />
    </section>
    <ModelBillingSettings identity={modelIdentity(config)} onIdentityLoaded={syncIdentity} onIdentityStale={() => setStale(true)} onDirtyChange={setBillingDirty} />
    <ModelUsageStats revision={usageRevision} />
  </div>;
}
