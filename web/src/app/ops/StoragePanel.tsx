import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Descriptions, Empty, Space, Spin, Table, Typography } from '../../shared/ui';
import { api } from '../../shared/api';
import { useI18n } from '../../shared/i18n';
import { errorText, type Spec } from './model';

type Inventory = { instances: Spec[]; standard_root: string; next_offset: number|null };
export default function StoragePanel({ resourceID, machineName, clusterName }: {
  resourceID: string; machineName: (id: string) => string; clusterName: (id: string) => string;
}) {
  const { t } = useI18n();
  const [data, setData] = useState<Inventory>(), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const request = useRef(0);
  const load = async (offset = 0) => {
    const current = ++request.current;
    setBusy(true); setError('');
    try {
      const next = await api<Inventory>('/ops/resources/' + encodeURIComponent(resourceID) + '/storage?offset=' + offset);
      if (current === request.current) setData(old => ({ ...next, instances: offset ? [...(old?.instances ?? []), ...next.instances] : next.instances }));
    } catch (e) { if (current === request.current) setError(errorText(e)); }
    finally { if (current === request.current) setBusy(false); }
  };
  useEffect(() => { void load(); return () => { ++request.current; }; }, [resourceID]);
  const path = (value: string|null) => value ? <Typography.Text copyable code style={{ overflowWrap: 'anywhere' }}>{value}</Typography.Text> : '—';
  return <section>
    <Space wrap><h3>{t('宿主机存储与挂载', 'Host storage and mounts')}</h3><Button size="small" loading={busy} onClick={() => void load()}>{t('刷新清单', 'Refresh storage')}</Button></Space>
    <p className="lm-ops-note">{t('显示最近一次 Agent 回执。执行应用或网关检查后可刷新；卸载及删除登记保留持久化数据。', 'Shows the latest Agent receipt. Refresh after inspecting the application or gateway. Uninstalling and deleting registration retain persistent data.')}</p>
    {data && <p className="lm-ops-note">{t('标准受管目录', 'Standard managed directory')}: {path(data.standard_root)}</p>}
    {error && <Alert showIcon type="error" title={t('存储清单读取失败', 'Storage could not be loaded')} description={error}/>}
    <Spin spinning={busy}>
      {data && !data.instances.length && <Empty description={t('尚无部署实例，部署后显示逐机器目录。', 'No deployment instances. Host directories appear after deployment.')}/>}
      {data?.instances.map(instance => <div key={instance.instance_id} className="lm-ops-mount">
        <Typography.Text strong>{machineName(instance.machine_id)} · {clusterName(instance.cluster_id)}</Typography.Text>
        <p className="lm-ops-note">{instance.instance_id} · {instance.state}{instance.retired ? ' · ' + t('已退役', 'Retired') : ''}</p>
        {!instance.storage ? <Alert showIcon type="info" title={t('尚无存储回执，请检查应用或网关；旧 Agent 需要升级。', 'No storage receipt. Inspect the application or gateway; older Agents need an update.')}/> : <>
          <Descriptions size="small" column={1} items={[
            { key: 'time', label: t('最近观测', 'Last observed'), children: instance.observed_at ?? '—' },
            { key: 'root', label: t('实例目录', 'Instance directory'), children: path(instance.storage.instance_root) },
            { key: 'state', label: t('状态文件', 'State file'), children: path(instance.storage.state_file) },
            ...(instance.storage.config_file ? [
              { key: 'config', label: t('网关完整配置', 'Complete gateway configuration'), children: path(instance.storage.config_file) },
              { key: 'version', label: t('当前版本目录', 'Current version directory'), children: path(instance.storage.version_root) },
            ] : []),
          ]}/>
          {!!instance.storage.mounts?.length && <Table<Spec> rowKey={m => [m.container_id,m.source,m.target].join(':')} size="small" pagination={false} scroll={{ x: 600 }} dataSource={instance.storage.mounts} columns={[
            { title: t('服务 / 类型', 'Service / type'), render: (_, m) => <>{m.service || '—'} · {m.type}{m.volume && <small>{m.volume}</small>}</> },
            { title: t('宿主机来源', 'Host source'), render: (_, m) => path(m.source) },
            { title: t('容器内路径', 'Container path'), render: (_, m) => path(m.target) },
            { title: t('访问', 'Access'), render: (_, m) => m.read_only ? 'RO' : 'RW' },
          ]}/>}
          {instance.storage.sites?.map((site: Spec) => <Descriptions key={site.fragment_id} size="small" column={1} title={t('网站分组', 'Website fragment') + ' · ' + site.fragment_id} items={[
            { key: 'root', label: t('网站配置材料目录', 'Website configuration material'), children: path(site.root) },
            ...(site.public_dir ? [{ key: 'public', label: t('静态文件目录', 'Static files'), children: path(site.public_dir) }] : []),
            ...(site.certificate_dir ? [{ key: 'cert', label: t('证书材料目录', 'Certificate material'), children: path(site.certificate_dir) }] : []),
          ]}/>)}
          {!instance.storage.mounts?.length && !instance.storage.sites?.length && <p className="lm-ops-note">{t('此回执没有活动挂载或网站分组，保留的数据仍位于原目录。', 'This receipt has no active mounts or website fragments. Retained data stays in its original directories.')}</p>}
          {(instance.storage.mounts_truncated || instance.storage.sites_truncated) && <Alert type="info" showIcon title={t('此回执的存储清单已截断。', 'The storage receipt is truncated.')}/>}
        </>}
      </div>)}
      {data?.next_offset != null && <Button disabled={busy} onClick={() => void load(data.next_offset!)}>{t('加载更多实例', 'Load more instances')}</Button>}
    </Spin>
  </section>;
}
