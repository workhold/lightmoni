import {useEffect, useRef, useState} from 'react';
import {useNavigate} from 'react-router-dom';
import {Alert, Button, Modal, Space, Tag} from '../../shared/ui';
import {ApiError, api, post} from '../../shared/api';
import {useI18n} from '../../shared/i18n';
import type {ToolTrace} from './types';

type Config = {unit: string; release_directory: string};
type Repair = {
  id: string;
  status: 'awaiting_approval' | 'expired' | 'stale' | 'applied';
  service_id: string;
  service_name: string;
  machine_name: string;
  target_revision: string;
  before: Config;
  after: Config;
  verification: {status: string; ready: boolean; current: boolean} | null;
};

const endpoint = (id: string) => `/service-target-repairs/${encodeURIComponent(id)}`;
const verificationPending = (repair: Repair) => ['queued', 'running'].includes(repair.verification?.status ?? '');

function ConfigDiff({repair}: {repair: Repair}) {
  const {t} = useI18n();
  const before = t('修正前', 'Before'), after = t('修正后', 'After');
  const fields = [['unit', 'systemd Unit'], ['release_directory', t('发布目录', 'Release directory')]] as const;
  return <div className="lm-assistant-alert-diff" aria-label={t('目标配置差异', 'Target configuration changes')}>
    <div className="lm-assistant-alert-diff-head"><span>{t('字段', 'Field')}</span><span>{before}</span><span>{after}</span></div>
    {fields.filter(([field]) => repair.before[field] !== repair.after[field]).map(([field, label]) =>
      <div className="lm-assistant-alert-diff-row changed" key={field}>
        <strong>{label}</strong>
        <div><span className="lm-assistant-alert-mobile-label">{before}</span><pre>{repair.before[field]}</pre></div>
        <div><span className="lm-assistant-alert-mobile-label">{after}</span><pre>{repair.after[field]}</pre></div>
      </div>)}
  </div>;
}

export default function TargetRepairProgress({tool, canApprove}: {tool: ToolTrace; canApprove: boolean}) {
  const {t} = useI18n(), navigate = useNavigate();
  const candidateId = (tool.result as {id?: unknown} | undefined)?.id;
  const id = typeof candidateId === 'string' && /^[0-9a-f]{32}$/.test(candidateId) ? candidateId : undefined;
  const [record, setRecord] = useState<Repair>();
  const [review, setReview] = useState<Repair>();
  const [failure, setFailure] = useState('');
  const [applyFailure, setApplyFailure] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);

  useEffect(() => {
    if (!id || !canApprove || submitting) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined, pending = false;
    async function read() {
      try {
        const next = await api<Repair>(endpoint(id!), {signal: controller.signal});
        if (controller.signal.aborted) return;
        if (next.id !== id) throw Error('repair identity mismatch');
        setRecord(next);
        setFailure('');
        pending = verificationPending(next);
      } catch {
        if (controller.signal.aborted) return;
        setFailure(t('暂时无法核对修正状态', 'Could not verify the current repair status'));
      }
      if (pending) timer = setTimeout(read, 3000);
    }
    void read();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [id, canApprove, refresh, submitting, t]);

  async function apply() {
    if (!canApprove || !review || review.id !== id || failure || submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    setApplyFailure('');
    try {
      const next = await post<Repair>(`${endpoint(review.id)}/apply`, {confirm: true, expected_revision: review.target_revision});
      if (next.id !== review.id || next.status !== 'applied') throw Error('repair receipt missing');
      setRecord(next);
    } catch (error) {
      const label = error instanceof ApiError && error.message === 'agent_not_ready'
        ? t('主机暂未就绪，配置未保存', 'Host is not ready. Configuration was not saved.')
        : t('保存结果待核对，请刷新原提案', 'Refresh the original proposal to check whether it was saved');
      setApplyFailure(label);
    } finally {
      setReview(undefined);
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  if (!canApprove || !id) return null;
  const current = record?.id === id ? record : undefined;
  const verification = current?.verification;
  const statuses = {
    awaiting_approval: t('待审核', 'Awaiting review'), expired: t('已过期', 'Expired'),
    stale: t('配置或预检已变化', 'Configuration or preflight changed'), applied: t('配置已保存', 'Configuration saved'),
  };
  const verificationLabel = verification?.status === 'queued' ? t('主机预检排队中', 'Host preflight queued')
    : verification?.status === 'running' ? t('主机预检执行中', 'Running host preflight')
    : verification?.status === 'completed'
      ? verification.current
        ? verification.ready ? t('主机预检通过', 'Host preflight passed') : t('主机预检未通过', 'Host preflight failed')
        : t('预检已成为历史记录', 'Preflight is historical')
      : t('主机预检结果待核对', 'Host preflight needs verification');

  return <div className="lm-assistant-alert-proposal lm-assistant-target-repair">
    <div className="lm-assistant-code-task-header">
      <Space wrap><strong>{t('服务目标修正', 'Service target repair')}</strong>
        <Tag color={current?.status === 'applied' ? 'success' : undefined}>{current ? statuses[current.status] : t('正在核对', 'Verifying')}</Tag>
      </Space>
      <Button type="text" size="small" disabled={submitting} onClick={() => {setApplyFailure(''); setRefresh(value => value + 1);}}>{t('刷新修正记录', 'Refresh repair')}</Button>
    </div>
    {(failure || (current?.status === 'awaiting_approval' && applyFailure)) && <Alert showIcon type="warning" title={failure || applyFailure}/>}
    {current && <>
      <p className="lm-assistant-code-task-meta">{current.service_name} · {current.machine_name}</p>
      <ConfigDiff repair={current}/>
      <Space wrap>
        {verification && <Tag color={verification.ready && verification.current ? 'success' : verificationPending(current) ? 'processing' : 'warning'}>{verificationLabel}</Tag>}
        {current.status === 'awaiting_approval' && <Button type="primary" disabled={!!failure || submitting} onClick={() => setReview(current)}>{t('审核修正', 'Review repair')}</Button>}
        <Button type="link" onClick={() => navigate(`/services?service=${encodeURIComponent(current.service_id)}`)}>{t('查看服务目标', 'View service target')}</Button>
      </Space>
    </>}
    <Modal open={review?.id === id} title={t('确认修正服务目标', 'Confirm service target repair')}
      okText={t('保存并预检', 'Save and verify')} cancelText={t('取消', 'Cancel')}
      confirmLoading={submitting} okButtonProps={{disabled: !!failure}}
      cancelButtonProps={{disabled: submitting}} mask={{closable: !submitting}} closable={!submitting} keyboard={!submitting}
      onCancel={() => {if (!submittingRef.current) setReview(undefined);}} onOk={() => void apply()} destroyOnHidden>
      {review && <><p>{review.service_name} · {review.machine_name}</p><ConfigDiff repair={review}/></>}
    </Modal>
  </div>;
}
