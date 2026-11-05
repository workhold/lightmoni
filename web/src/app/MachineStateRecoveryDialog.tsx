import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Checkbox, Descriptions, Input, Modal, Select, Space, Table, Typography } from '../shared/ui';
import { api } from '../shared/api';
import { useI18n } from '../shared/i18n';
import { reusableMachineCredential, sshCredentialLabel } from './machine-credentials';

type Host = { id: string; name: string };
type Credential = { id: string; account_id: string; username: string; account_revision: number; method: string; name?: string; retention?: string; expires_at: string; secret_fingerprint: string; revoked_at?: string; secret_cleared_at?: string };
type Recovery = { id: string; machine_id: string; credential_id: string; status: string; expires_at: string; finished_at: string;
  plan: { machine: Host & { agent_id: string; address: string; port: number }; reason: string; effects: { entries: { table: string; id: string; state: string; code: string }[]; identities: unknown[] } };
  receipt: { corrected_records?: number; credentials_revoked?: number; data_retained?: boolean } };

export default function MachineStateRecoveryDialog({ machine, onClose, onRefresh }: { machine: Host; onClose(): void; onRefresh(): Promise<void> }) {
  const { t, language } = useI18n();
  const [credentials, setCredentials] = useState<Credential[]>([]), [credential, setCredential] = useState<string>();
  const [reason, setReason] = useState(''), [confirmName, setConfirmName] = useState(''), [checked, setChecked] = useState(false);
  const [record, setRecord] = useState<Recovery>(), [busy, setBusy] = useState(false), [error, setError] = useState(''), [uncertain, setUncertain] = useState(false);
  const [now, setNow] = useState(Date.now());
  const pending = useRef(false), mounted = useRef(true);
  const prefix = `/machines/${encodeURIComponent(machine.id)}/state-recoveries`;
  const validate = (next: Recovery) => {
    if (!next?.id || next.machine_id !== machine.id || next.plan?.machine.id !== machine.id) throw Error(t('恢复记录与目标主机不匹配', 'The recovery record does not match this host'));
    return next;
  };
  const read = async (resume = false) => {
    const [detail, history] = await Promise.all([
      api<{ machine: Host; credentials: Credential[] }>(`/machines/${encodeURIComponent(machine.id)}`), api<Recovery[]>(prefix),
    ]);
    if (detail.machine.id !== machine.id || !Array.isArray(history)) throw Error(t('主机恢复信息无效', 'Invalid host recovery information'));
    history.forEach(validate);
    if (!mounted.current) return;
    const keys = detail.credentials.filter(reusableMachineCredential);
    setCredentials(keys); setCredential(previous => keys.some(key => key.id === previous) ? previous : keys[0]?.id);
    const next = record ? history.find(item => item.id === record.id) : history.find(item => item.status === 'awaiting_approval' && Date.parse(item.expires_at) > Date.now()
      && (!resume || item.credential_id === credential && item.plan.reason === reason.trim()));
    if (record && !next || resume && !record && !next) throw Error(t('尚未确认原恢复计划，请稍后刷新，不要重复创建', 'The original recovery plan is not confirmed. Refresh shortly instead of creating another.'));
    if (next) setRecord(next);
    setUncertain(false);
  };
  const run = async (operation: 'read' | 'plan' | 'apply' | 'cancel') => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError('');
    try {
      if (operation === 'read') await read(uncertain);
      else if (operation === 'plan') {
        setUncertain(true);
        const next = validate(await api<Recovery>(prefix + '/plan', { method: 'POST', body: JSON.stringify({ credential_id: credential, reason: reason.trim() }) }));
        if (mounted.current) { setRecord(next); setUncertain(false); }
      } else if (record) {
        setUncertain(true);
        const next = validate(await api<Recovery>(`${prefix}/${encodeURIComponent(record.id)}/${operation}`, {
          method: 'POST', body: JSON.stringify(operation === 'apply' ? { confirm: true, confirm_name: confirmName } : {}),
        }));
        if (next.id !== record.id) throw Error(t('恢复计划发生变化，请刷新', 'The recovery plan changed. Refresh it.'));
        if (mounted.current) { setRecord(next); setUncertain(false); }
        await onRefresh();
      }
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : t('恢复操作失败', 'Recovery failed'));
      if (operation !== 'read') { try { await read(true); } catch { /* Keep the refresh gate after an uncertain response. */ } }
    } finally { pending.current = false; if (mounted.current) setBusy(false); }
  };
  useEffect(() => { mounted.current = true; void run('read'); return () => { mounted.current = false; }; }, []);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  const expired = !!record && Date.parse(record.expires_at) <= now;
  const reasonValid = !!reason.trim() && new TextEncoder().encode(reason).length <= 1000 && !/[\u0000-\u001f\u007f]/u.test(reason);
  const label = (table: string) => ({ agent_jobs: t('Agent 作业', 'Agent jobs'), privileged_jobs: t('受管执行', 'Managed executions'), task_runs: t('任务中心', 'Task runs'), ops_platform_runs: t('部署与配置', 'Deployments and configuration'), machine_deployments: t('Agent 安装', 'Agent installations'), machine_uninstallations: t('Agent 卸载', 'Agent uninstallations'), machine_agent_updates: t('Agent 升级', 'Agent updates'), machine_agent_runtime_plans: t('运行模式', 'Runtime modes') }[table] || table);
  const state = (value: string) => ({ queued: t('排队中', 'Queued'), running: t('执行中', 'Running'), unknown: t('结果未知', 'Unknown'), awaiting_approval: t('待审阅', 'Awaiting review') }[value] || value);
  return <Modal open title={t(`修正 Agent 状态 · ${machine.name}`, `Correct Agent state · ${machine.name}`)} width={760} footer={null} onCancel={() => { if (!pending.current) onClose(); }} closable={!busy} maskClosable={false} destroyOnHidden>
    <Alert showIcon type="info" title={t('远端已卸载，中心仍被旧状态阻塞', 'The Agent is removed but old center records still block maintenance')} description={t('通过 SSH 核对程序、服务和工作进程均已移除后，审阅并结束旧任务与维护，撤销旧身份。所有配置、缓存、业务容器及数据保留；重新接入前可继续使用 SSH 恢复卸载处理保留的 Agent 状态。', 'After SSH confirms the Agent runtime, services, and workers are absent, review and close stale work and retire the old identity. Configuration, cached telemetry, business containers, and data are retained. Use SSH recovery uninstall to handle retained Agent state before enrolling again.')} />
    {!record && <div className="lm-machine-form-notice">
      <Typography.Paragraph>{t('SSH 登录凭据', 'SSH login credential')}</Typography.Paragraph>
      <Select aria-label={t('状态修正 SSH 凭据', 'State recovery SSH credential')} style={{ width: '100%' }} value={credential} disabled={busy} onChange={setCredential} options={credentials.map(item => ({ value: item.id, label: sshCredentialLabel(item) }))} />
      <Typography.Paragraph className="lm-machine-form-notice">{t('核查结论与修正原因', 'Verification findings and reason')}</Typography.Paragraph>
      <Input.TextArea aria-label={t('状态修正原因', 'State recovery reason')} value={reason} onChange={event => setReason(event.target.value)} disabled={busy} rows={3} maxLength={1000} />
      <Button className="lm-machine-form-notice" type="primary" loading={busy} disabled={!credential || !reasonValid || uncertain} onClick={() => void run('plan')}>{t('只读核对并生成恢复计划', 'Verify read-only and prepare recovery')}</Button>
    </div>}
    {record && <div className="lm-machine-form-notice">
      <Descriptions size="small" column={1} items={[
        { key: 'target', label: t('已核对主机', 'Verified host'), children: `${record.plan.machine.name} · ${record.plan.machine.address}:${record.plan.machine.port}` },
        { key: 'reason', label: t('恢复原因', 'Recovery reason'), children: record.plan.reason },
        { key: 'expiry', label: t('审阅有效至', 'Review valid until'), children: new Date(record.expires_at).toLocaleString(language) },
      ]} />
      <Table size="small" rowKey={entry => entry.table + ':' + entry.id} dataSource={record.plan.effects.entries} pagination={{ pageSize: 8, hideOnSinglePage: true }} columns={[
        { title: t('影响范围', 'Affected work'), dataIndex: 'table', render: label }, { title: t('原状态', 'Previous state'), dataIndex: 'state', render: state },
        { title: t('记录', 'Record'), dataIndex: 'id', render: (value: string) => <Typography.Text code>{value}</Typography.Text> },
      ]} />
      {record.status === 'awaiting_approval' && <>
        <Alert className="lm-machine-form-notice" type="warning" showIcon title={t('结束旧身份并释放维护阻塞', 'Retire the old identity and release maintenance blocks')} description={t('排队工作将取消；已经执行但无法确认的工作保留未知结论并登记人工核对。不会将它们标记成功。旧身份撤销后必须重新接入。', 'Queued work will be cancelled. Started work with uncertain results keeps an unknown outcome with an audited manual resolution. No uncertain work is marked successful. The retired identity must enroll again.')} />
        <Checkbox className="lm-machine-form-notice" checked={checked} disabled={busy} onChange={event => setChecked(event.target.checked)}>{t('我已核对主机现场并审阅以上影响', 'I verified this host and reviewed the effects above')}</Checkbox>
        <Input className="lm-machine-form-notice" aria-label={t('输入主机名称确认状态修正', 'Enter the host name to confirm recovery')} placeholder={record.plan.machine.name} value={confirmName} disabled={busy} onChange={event => setConfirmName(event.target.value)} />
        {expired && <Alert type="warning" title={t('计划已过期，请取消后重新核对', 'The plan expired. Cancel it and verify again.')} />}
        <Space className="lm-machine-form-notice"><Button danger type="primary" loading={busy} disabled={!checked || confirmName !== record.plan.machine.name || expired || uncertain} onClick={() => void run('apply')}>{t('确认修正状态', 'Confirm state correction')}</Button><Button disabled={busy || uncertain} onClick={() => void run('cancel')}>{t('取消恢复计划', 'Cancel recovery plan')}</Button></Space>
      </>}
      {record.status === 'succeeded' && <Alert showIcon type="success" title={t('状态已修正，可继续恢复或重新接入', 'State corrected; continue recovery or enroll again')} description={t(`已处理 ${record.receipt.corrected_records ?? 0} 条旧记录；业务数据和配置已保留。`, `${record.receipt.corrected_records ?? 0} stale records handled. Business data and configuration are retained.`)} />}
      {['cancelled', 'expired'].includes(record.status) && <Button disabled={busy} onClick={() => { setRecord(undefined); setChecked(false); setConfirmName(''); }}>{t('重新核对', 'Verify again')}</Button>}
    </div>}
    {error && <Alert className="lm-machine-form-notice" role="alert" type="error" showIcon title={error} />}
    <Button className="lm-machine-form-notice" disabled={busy} onClick={() => void run('read')}>{t('刷新恢复状态', 'Refresh recovery state')}</Button>
  </Modal>;
}
