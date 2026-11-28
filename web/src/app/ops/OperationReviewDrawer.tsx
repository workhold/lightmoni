import { useEffect, useState } from 'react';
import { api, post } from '../../shared/api';
import CodeBlock from '../../shared/CodeBlock';
import { useI18n } from '../../shared/i18n';
import { Alert, Button, Checkbox, Descriptions, Drawer, Space, Spin } from '../../shared/ui';
import { errorText } from './model';
import OperationStatus from './OperationStatus';

interface OperationReview {
  id: string;
  resource_id: string;
  resource_revision: number;
  operation: string;
  state: string;
  expires_at: string;
  preview: {
    resource: { id: string; name: string; agent_id: string; revision: number; config: unknown };
    operation: string;
    input: unknown;
  };
  receipt?: unknown;
}

const activeStates = new Set(['queued', 'leased', 'accepted', 'staging', 'activating', 'verifying', 'running']);

export default function OperationReviewDrawer({ runID, onClose }: { runID: string; onClose: () => void }) {
  const { t } = useI18n();
  const path = '/operations/runs/' + encodeURIComponent(runID);
  const [run, setRun] = useState<OperationReview>();
  const [readError, setReadError] = useState('');
  const [approvalError, setApprovalError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let active = false;
    let timer: number | undefined;
    const load = async () => {
      try {
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]);
        const { run: next } = await api<{ run: OperationReview }>(path, { signal });
        if (controller.signal.aborted) return;
        if (next.id !== runID || next.preview.resource.id !== next.resource_id ||
            next.preview.resource.revision !== next.resource_revision || next.preview.operation !== next.operation) {
          throw new Error(t('执行记录与原计划不一致', 'The execution record does not match the reviewed plan'));
        }
        setRun(next);
        setReadError('');
        active = activeStates.has(next.state);
      } catch (problem) {
        if (!controller.signal.aborted) { setChecked(false); setReadError(errorText(problem)); }
      } finally {
        if (active && !controller.signal.aborted) timer = window.setTimeout(load, 3000);
      }
    };
    void load();
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [path, runID, refresh, t]);

  const awaiting = run?.state === 'awaiting_approval';
  const expired = awaiting && !(Date.parse(run.expires_at) > Date.now());
  async function approve() {
    if (!run || !awaiting || expired || !checked || readError || busy) return;
    setBusy(true);
    setApprovalError('');
    setChecked(false);
    try { await post(path + '/approve', { revision: run.resource_revision }); }
    catch (problem) { setApprovalError(errorText(problem)); }
    finally { setRefresh(value => value + 1); setBusy(false); }
  }

  return <Drawer open title={t('审阅运维计划', 'Review operations plan')} onClose={onClose} closable={!busy} maskClosable={!busy} size="min(760px, 100vw)">
    <Space direction="vertical" style={{ width: '100%' }}>
      {readError && <Alert showIcon type="warning" title={t('运维计划读取失败', 'Could not read operations plan')} description={readError} action={<Button onClick={() => setRefresh(value => value + 1)}>{t('重试', 'Retry')}</Button>} />}
      {approvalError && <Alert showIcon type="error" title={t('未确认审批结果', 'Approval result unconfirmed')} description={approvalError} />}
      {!run && !readError && <Spin />}
      {run && <>
        <Descriptions size="small" column={1} items={[
          { key: 'target', label: t('资源', 'Resource'), children: run.preview.resource.name },
          { key: 'agent', label: t('目标 Agent', 'Target Agent'), children: run.preview.resource.agent_id },
          { key: 'action', label: t('操作', 'Action'), children: run.operation },
          { key: 'revision', label: t('修订', 'Revision'), children: run.resource_revision },
          { key: 'status', label: t('执行状态', 'Execution status'), children: <span role="status">{expired ? t('计划已过期', 'Plan expired') : <OperationStatus state={run.state} />}</span> },
        ]} />
        <CodeBlock language="json" ariaLabel={t('计划配置与输入', 'Plan configuration and input')}
          code={JSON.stringify({ configuration: run.preview.resource.config, input: run.preview.input }, null, 2)} />
        {run.receipt != null && <CodeBlock language="json" ariaLabel={t('执行回执', 'Execution receipt')} code={JSON.stringify(run.receipt, null, 2)} />}
        {awaiting && !expired && <Space wrap>
          <Checkbox checked={checked} disabled={!!readError || busy} onChange={event => setChecked(event.target.checked)}>{t('我已核对目标、操作和配置', 'I reviewed the target, action, and configuration')}</Checkbox>
          <Button type="primary" loading={busy} disabled={!checked || !!readError} onClick={() => void approve()}>{t('批准执行', 'Approve execution')}</Button>
        </Space>}
      </>}
    </Space>
  </Drawer>;
}
