import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Checkbox, Descriptions, Input, Modal, Space, Table, Tag, Typography } from '../shared/ui';
import { api } from '../shared/api';
import { useI18n } from '../shared/i18n';

type Host = { id: string; name: string };
type Blocker = { kind: 'executor_bootstrap' | 'task_run' | 'agent_job' | 'privileged_job'; id: string; state: string };
type Busy = { machine_id: string; busy: boolean; holder?: string; since?: string; maintenance_blockers?: Blocker[] };
type ClosedBootstrap = { id: string; status: string; resolved_at: string; resolved_by: string; resolution_reason: string };

export default function MachineMaintenanceFenceDialog({ machine, onClose, onRefresh }: { machine: Host; onClose(): void; onRefresh(): Promise<void> }) {
  const { t } = useI18n();
  const [busy, setBusy] = useState<Busy>(), [loading, setLoading] = useState(false), [error, setError] = useState('');
  const [selected, setSelected] = useState<Blocker>(), [reason, setReason] = useState(''), [checked, setChecked] = useState(false);
  const [closed, setClosed] = useState<ClosedBootstrap>(), [actionBusy, setActionBusy] = useState(false);
  const pending = useRef(false), mounted = useRef(true);
  const load = async () => {
    try {
      const next = await api<Busy>(`/machines/${encodeURIComponent(machine.id)}/busy`);
      if (!mounted.current || next.machine_id !== machine.id) return;
      setBusy(next); setSelected(previous => next.maintenance_blockers?.find(item => item.id === previous?.id && item.kind === 'executor_bootstrap' && item.state === 'unknown'));
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : t('读取维护围栏失败', 'Failed to read maintenance fences'));
    }
  };
  const read = async () => {
    if (pending.current) return;
    pending.current = true; setLoading(true); setError('');
    try { await load(); } finally { pending.current = false; if (mounted.current) setLoading(false); }
  };
  const closeBootstrap = async () => {
    if (!selected || pending.current) return;
    pending.current = true; setActionBusy(true); setError('');
    try {
      const next = await api<ClosedBootstrap>(`/machines/${encodeURIComponent(machine.id)}/executor-bootstraps/${encodeURIComponent(selected.id)}/reconcile`, {
        method: 'POST', body: JSON.stringify({ confirm: true, reason: reason.trim() }),
      });
      if (!mounted.current || next.id !== selected.id) return;
      setClosed(next); setSelected(undefined); setChecked(false); setReason('');
      await load(); await onRefresh();
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : t('闭环失败', 'Closure failed'));
    } finally {
      pending.current = false; if (mounted.current) setActionBusy(false);
    }
  };
  const releaseLane = async () => {
    if (!busy?.busy || pending.current) return;
    pending.current = true; setActionBusy(true); setError('');
    try {
      await api(`/machines/${encodeURIComponent(machine.id)}/busy/release`, { method: 'POST', body: JSON.stringify({ confirm: true, reason: reason.trim() }) });
      setReason(''); await load(); await onRefresh();
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : t('释放忙状态失败', 'Failed to release the busy lane'));
    } finally {
      pending.current = false; if (mounted.current) setActionBusy(false);
    }
  };
  useEffect(() => { mounted.current = true; void read(); return () => { mounted.current = false; }; }, [machine.id]);
  const blockers = busy?.maintenance_blockers ?? [];
  const kindText = (kind: Blocker['kind']) => ({
    executor_bootstrap: t('历史首装执行器', 'Legacy first-install executor'),
    task_run: t('任务中心执行', 'Task-center run'),
    agent_job: t('Agent 作业', 'Agent job'),
    privileged_job: t('提权执行', 'Privileged job'),
  } as Record<Blocker['kind'], string>)[kind];
  const guidance = (blocker: Blocker) => blocker.kind === 'executor_bootstrap'
    ? t('当前执行器心跳满足条件时，可在下方人工闭环；历史 unknown 不会被改成成功。', 'When the current executor heartbeat qualifies, close it manually below. The historical unknown is never rewritten as success.')
    : t('请先到任务中心或对应执行历史完成只读核对；运行中任务请等待结束。', 'Verify it read-only in Task Center or the corresponding execution history first; wait for running work to finish.');
  return <Modal title={t('维护围栏与恢复入口', 'Maintenance fences and recovery')} open destroyOnClose footer={<Space>
    <Button loading={loading} disabled={actionBusy} onClick={()=>void read()}>{t('刷新', 'Refresh')}</Button>
    <Button disabled={loading||actionBusy} onClick={onClose}>{t('关闭', 'Close')}</Button>
  </Space>}>
    <Typography.Paragraph>{t('这里区分内存操作车道和持久化 unknown 围栏。释放内存车道不会清除任务结果；闭环历史首装围栏需要当前执行器心跳证据和人工确认。', 'This separates the in-memory operation lane from durable unknown fences. Releasing the lane never clears task outcomes; closing a legacy first-install fence requires current executor-heartbeat evidence and human confirmation.')}</Typography.Paragraph>
    {error&&<Alert type="error" showIcon title={error}/>}
    {busy?.busy&&<Alert type="warning" showIcon title={t('内存操作车道占用中', 'In-memory operation lane is busy')} description={<Descriptions size="small" column={1} items={[
      {key:'holder',label:t('持有者', 'Holder'),children:busy.holder||'—'}, {key:'since',label:t('开始时间', 'Since'),children:busy.since?new Date(busy.since).toLocaleString():'—'},
    ]}/>}/>}
    <Table rowKey={item=>`${item.kind}:${item.id}`} size="small" pagination={false} dataSource={blockers} locale={{emptyText:t('没有持久化维护围栏', 'No durable maintenance fences')}} columns={[
      {title:t('类型', 'Kind'),render:(_,item:Blocker)=><>{kindText(item.kind)}<br/><Typography.Text code copyable>{item.id}</Typography.Text></>},
      {title:t('状态', 'State'),render:(_,item:Blocker)=><Tag color={item.state==='unknown'?'warning':item.state==='running'?'processing':'default'}>{item.state}</Tag>},
      {title:t('处理', 'Action'),render:(_,item:Blocker)=><Space direction="vertical" size={4}><Typography.Text type="secondary">{guidance(item)}</Typography.Text>{item.kind==='executor_bootstrap'&&item.state==='unknown'&&<Button size="small" disabled={actionBusy} onClick={()=>setSelected(item)}>{t('选择人工闭环', 'Select for manual closure')}</Button>}</Space>},
    ]}/>
    {selected&&<div className="lm-machine-form-notice">
      <Alert type="warning" showIcon title={t('人工闭环不会访问远端主机', 'Manual closure does not contact the remote host')} description={t('仅当中心已有同主机、同 Agent、更新且心跳新鲜的 active 执行器时允许执行。历史记录保持 unknown，只写入闭环人、时间和原因。', 'Allowed only when the center already has a newer active executor for the same host and Agent with a fresh heartbeat. The historical record remains unknown; only closure actor, time, and reason are saved.')}/>
      <Input.TextArea aria-label={t('闭环原因', 'Closure reason')} rows={3} maxLength={500} value={reason} onChange={event=>setReason(event.target.value)} disabled={actionBusy}/>
      <Checkbox checked={checked} disabled={actionBusy} onChange={event=>setChecked(event.target.checked)}>{t('我已核对当前执行器在线且不属于仍在执行的首装', 'I verified the current executor is online and is not still performing first installation')}</Checkbox>
      <Space><Button danger type="primary" disabled={actionBusy||!checked||!reason.trim()} loading={actionBusy} onClick={()=>void closeBootstrap()}>{t('确认闭环历史围栏', 'Confirm legacy-fence closure')}</Button><Button disabled={actionBusy} onClick={()=>{setSelected(undefined);setChecked(false)}}>{t('取消', 'Cancel')}</Button></Space>
    </div>}
    {busy?.busy&&<div className="lm-machine-form-notice">
      <Input.TextArea aria-label={t('释放内存车道原因', 'In-memory lane release reason')} rows={2} maxLength={500} value={reason} onChange={event=>setReason(event.target.value)} disabled={actionBusy}/>
      <Button danger disabled={actionBusy||!reason.trim()} loading={actionBusy} onClick={()=>void releaseLane()}>{t('仅释放异常中断的内存车道', 'Release only an abnormally interrupted in-memory lane')}</Button>
    </div>}
    {closed&&<Alert type="success" showIcon title={t('历史围栏已人工闭环', 'Legacy fence was manually closed')} description={<>{t('原结果仍为 unknown。', 'The original outcome remains unknown.')}{closed.resolved_at&&` ${new Date(closed.resolved_at).toLocaleString()}`}</>}/>}
  </Modal>;
}
