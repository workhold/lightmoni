import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CloudUploadOutlined, PlusOutlined, ReloadOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import { Alert, App, Button, Card, Descriptions, Divider, Empty, Form, Input, Modal, Popconfirm, Select, Space, Spin, Table, Tag, Typography } from '../shared/ui';
import { api, post } from '../shared/api';
import { useI18n } from '../shared/i18n';
import type { User } from '../shared/types';
import './service-deployments.css';

type Service = { id: string; name: string; description: string; repository_url: string; updated_at: string };
type Machine = { id: string; name: string; address: string; agent_status: string; agent_id: string };
type TargetPreflight = { id: string; status: string; ready: boolean; current: boolean; snapshot: { preflight?: { systemd_available?: boolean; unit_exists?: boolean; active_state?: string; enabled?: boolean | 'unknown'; unit_file_state?: string; filesystem_check_supported?: boolean; current_version?: string; release_directory_exists?: boolean; release_directory_writable?: boolean; observed_at?: string } }; error_code: string; expires_at: string };
type Target = { id: string; machine_id: string; machine_name: string; adapter: string; config: Record<string, unknown>; status: string; desired_release_id: string; preflight?: TargetPreflight | null };
type Release = { id: string; version: string; source_type: string; source_ref: string; artifact_digest: string; status: string; created_at: string };
type Deployment = { id: string; target_id: string; release_id: string; adapter: string; status: string; phase: string; operation_id: string; plan: Record<string, unknown>; receipt?: { state?: string; code?: string; summary?: string }; error: string; created_at: string; approved_at: string };
type Event = { id: string; phase: string; state: string; code: string; summary: string; actor: string; created_at: string };
type ServiceDetail = { service: Service; targets: Target[]; releases: Release[]; deployments: Deployment[] };

const statusColor: Record<string, string> = { succeeded: 'success', running: 'processing', agent_ready: 'processing', staging: 'processing', activating: 'processing', verifying: 'processing', awaiting_approval: 'warning', failed: 'error', rollback_pending: 'warning', rolling_back: 'processing', rolled_back: 'default', cancelled: 'default' };

export default function ServiceDeploymentsPage({ user }: { user: User }) {
  const { t, language } = useI18n();
  const { message } = App.useApp();
  const [params, setParams] = useSearchParams();
  const [services, setServices] = useState<Service[]>([]);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [detail, setDetail] = useState<ServiceDetail>();
  const [events, setEvents] = useState<Event[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [serviceModal, setServiceModal] = useState(false);
  const [targetModal, setTargetModal] = useState(false);
  const [editingTarget, setEditingTarget] = useState<Target>();
  const [releaseModal, setReleaseModal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selectedDeployment, setSelectedDeployment] = useState<Deployment>();
  const [preflighting, setPreflighting] = useState("");
  const [releaseSelection, setReleaseSelection] = useState<Record<string, string>>({});
  const [serviceForm] = Form.useForm();
  const [targetForm] = Form.useForm();
  const [releaseForm] = Form.useForm();
  const selectedID = params.get('service') || services[0]?.id || '';

  const load = useCallback(async (id?: string) => {
    setLoading(true); setError('');
    try {
      const [nextServices, nextMachines] = await Promise.all([api<Service[]>('/services'), api<Machine[]>('/machines')]);
      setServices(nextServices); setMachines(nextMachines);
      const serviceID = id || params.get('service') || nextServices[0]?.id;
      if (!serviceID) { setDetail(undefined); return; }
      const next = await api<ServiceDetail>(`/services/${encodeURIComponent(serviceID)}`);
      setDetail(next);
      if (params.get('service') !== serviceID) setParams(current => { current.set('service', serviceID); return current; }, { replace: true });
      const deploymentID = params.get('deployment');
      const deployment = next.deployments.find(item => item.id === deploymentID) || next.deployments[0];
      setSelectedDeployment(deployment);
      if (deployment) setEvents(await api<Event[]>(`/deployments/${encodeURIComponent(deployment.id)}/events`)); else setEvents([]);
    } catch (value) { setError(value instanceof Error ? value.message : t('读取服务部署信息失败', 'Unable to load service deployments')); }
    finally { setLoading(false); }
  }, [params, setParams, t]);

  useEffect(() => { void load(); }, [load]);

  const selectService = async (id: string) => { setParams({ service: id }); await load(id); };
  const createService = async (values: Record<string, string>) => {
    setBusy(true); try { const created = await post<Service>('/services', values); setServiceModal(false); serviceForm.resetFields(); await load(created.id); void message.success(t('服务已创建', 'Service created')); } catch (value) { setError(value instanceof Error ? value.message : t('创建服务失败', 'Unable to create service')); } finally { setBusy(false); }
  };
  const saveTarget = async (values: Record<string, string>) => {
    if (!detail) return; setBusy(true);
    try {
      const input = { ...(editingTarget ? {} : { machine_id: values.machine_id }), adapter: 'systemd', config: { unit: values.unit, release_directory: values.release_directory } };
      if (editingTarget) await api(`/services/${encodeURIComponent(detail.service.id)}/targets/${encodeURIComponent(editingTarget.id)}`, { method: 'PATCH', body: JSON.stringify(input) });
      else await post(`/services/${encodeURIComponent(detail.service.id)}/targets`, input);
      setTargetModal(false); setEditingTarget(undefined); targetForm.resetFields(); await load(detail.service.id); void message.success(t('服务目标已保存', 'Service target saved'));
    } catch (value) { setError(value instanceof Error ? value.message : t('保存服务目标失败', 'Unable to save service target')); }
    finally { setBusy(false); }
  };
  const openTargetEditor = (target?: Target) => {
    setEditingTarget(target);
    targetForm.setFieldsValue(target ? { unit: target.config.unit, release_directory: target.config.release_directory } : { machine_id: undefined, unit: undefined, release_directory: undefined });
    setTargetModal(true);
  };
  const preflight = async (target: Target) => {
    if (!detail) return; setPreflighting(target.id); setError('');
    try {
      await post(`/services/${encodeURIComponent(detail.service.id)}/targets/${encodeURIComponent(target.id)}/preflight`, { confirm: true });
      await load(detail.service.id);
      void message.success(t('只读预检任务已提交；完成后刷新查看结果', 'Read-only preflight queued; refresh to see its result'));
    } catch (value) { setError(value instanceof Error ? value.message : t('提交主机预检失败', 'Unable to submit host preflight')); }
    finally { setPreflighting(""); }
  };
  const createRelease = async (values: Record<string, string>) => {
    if (!detail) return; setBusy(true); try { await post(`/services/${encodeURIComponent(detail.service.id)}/releases`, { ...values, manifest: {} }); setReleaseModal(false); releaseForm.resetFields(); await load(detail.service.id); void message.success(t('制品版本已登记', 'Release registered')); } catch (value) { setError(value instanceof Error ? value.message : t('登记制品失败', 'Unable to register release')); } finally { setBusy(false); }
  };
  const plan = async (targetID: string, releaseID: string) => {
    if (!detail) return; setBusy(true); try { const result = await post<Deployment>(`/services/${encodeURIComponent(detail.service.id)}/deployments/plan`, { target_id: targetID, release_id: releaseID }); setParams({ service: detail.service.id, deployment: result.id }); await load(detail.service.id); void message.success(result.plan.provider_plan_reason === 'artifact_transport_required' ? t('计划已生成；制品上传和 Agent 下载尚未接入，当前不能审批', 'Plan created; artifact upload and Agent download are not connected, so it cannot be approved yet') : t('预览计划已生成；请先执行只读预检，再重新生成计划。制品分发接入前仍不能审批', 'Preview plan created; run read-only preflight and create a fresh plan. Approval remains unavailable until artifact delivery is connected')); } catch (value) { setError(value instanceof Error ? value.message : t('生成部署计划失败', 'Unable to create deployment plan')); } finally { setBusy(false); }
  };
  const approve = async (deployment: Deployment) => {
    setBusy(true); try { await post(`/deployments/${encodeURIComponent(deployment.id)}/approve`, { confirm: true, expected_state: deployment.status }); await load(detail?.service.id); void message.success(t('部署已批准，等待 Agent 执行', 'Deployment approved; waiting for Agent execution')); } catch (value) { setError(value instanceof Error ? value.message : t('批准部署失败', 'Unable to approve deployment')); } finally { setBusy(false); }
  };
  const cancel = async (deployment: Deployment) => {
    setBusy(true); try { await post(`/deployments/${encodeURIComponent(deployment.id)}/cancel`, { confirm: true, expected_state: deployment.status }); await load(detail?.service.id); void message.success(t('部署计划已取消', 'Deployment plan cancelled')); } catch (value) { setError(value instanceof Error ? value.message : t('取消部署失败', 'Unable to cancel deployment')); } finally { setBusy(false); }
  };
  const rollback = async (deployment: Deployment) => {
    setBusy(true); try { await post(`/deployments/${encodeURIComponent(deployment.id)}/rollback`, { confirm: true, reason: t('管理员从部署工作台请求回滚', 'Rollback requested from deployment workspace') }); await load(detail?.service.id); void message.success(t('已创建回滚提案', 'Rollback proposal created')); } catch (value) { setError(value instanceof Error ? value.message : t('创建回滚提案失败', 'Unable to create rollback proposal')); } finally { setBusy(false); }
  };
  const canApprove = (deployment: Deployment) => {
    const plan = deployment.plan as { provider_plan_status?: unknown; actions?: unknown; capabilities?: unknown };
    if (plan.provider_plan_status !== 'ready' || !Array.isArray(plan.actions) || !plan.actions.length || !Array.isArray(plan.capabilities) || !plan.capabilities.length) return false;
    return (plan.actions as Array<Record<string, any>>).some(action => {
      if (action?.kind !== 'health_check') return false;
      const kind = action.check?.kind;
      const capability = kind === 'systemd-active' ? 'health.systemd' : kind === 'http' ? 'health.http' : kind === 'tcp' ? 'health.tcp' : '';
      return Boolean(capability && (plan.capabilities as string[]).includes(capability));
    });
  };
  const selectDeployment = async (deployment: Deployment) => { setSelectedDeployment(deployment); setParams({ service: detail?.service.id || '', deployment: deployment.id }); setEvents(await api<Event[]>(`/deployments/${encodeURIComponent(deployment.id)}/events`)); };
  const serviceOptions = useMemo(() => services.map(item => ({ value: item.id, label: item.name })), [services]);
  const machineOptions = machines.map(item => ({ value: item.id, label: `${item.name} · ${item.address} · ${item.agent_status === 'online' ? t('Agent 在线', 'Agent online') : t('Agent 未在线', 'Agent offline')}` }));
  const statusName = (value: string) => ({
    draft: t('草稿', 'Draft'), preflight: t('预检中', 'Preflight'), awaiting_approval: t('等待审批', 'Awaiting approval'),
    queued: t('等待 Agent 预检', 'Waiting for Agent preflight'), preflighting: t('Agent 正在预检', 'Agent preflight running'), completed: t('预检完成', 'Preflight complete'), expired: t('预检已过期', 'Preflight expired'),
    agent_ready: t('等待 Agent 执行', 'Waiting for Agent'), staging: t('暂存中', 'Staging'), activating: t('切换服务中', 'Activating'),
    verifying: t('健康检查中', 'Health checking'), running: t('运行中', 'Running'), succeeded: t('健康检查通过', 'Health check passed'),
    failed: t('执行失败', 'Failed'), rollback_pending: t('等待回滚', 'Rollback pending'), rolling_back: t('回滚中', 'Rolling back'),
    rolled_back: t('已回滚', 'Rolled back'), cancelled: t('已取消', 'Cancelled'), unknown: t('结果待确认', 'Result needs review'),
    accepted: t('Agent 已接收', 'Accepted by Agent'), rollback_requested: t('已提交回滚提案', 'Rollback requested'),
  }[value] ?? value);
  const deploymentStatusName = (deployment: Deployment) => {
    if (deployment.status !== 'awaiting_approval' || canApprove(deployment)) return statusName(deployment.status);
    if (deployment.plan.provider_plan_reason === 'artifact_transport_required') return t('等待制品分发能力', 'Waiting for artifact delivery');
    if (deployment.plan.provider_plan_reason === 'agent_preflight_required') {
      const preflight = deployment.plan.preflight as TargetPreflight | undefined;
      if (preflight?.status === 'queued' || preflight?.status === 'running') return t('Agent 预检进行中', 'Agent preflight running');
      if (preflight?.status === 'failed' || preflight?.status === 'unknown' || preflight?.status === 'expired' || (preflight?.status === 'completed' && (!preflight.current || !preflight.ready))) return t('需重新执行预检', 'Preflight must be repeated');
      return t('需运行只读预检', 'Read-only preflight required');
    }
    return t('暂不可审批', 'Approval unavailable');
  };

  return <div className="lm-page lm-deployments-page">
    <div className="lm-page-heading"><div><h1>{t('服务部署', 'Service deployments')}</h1><p>{t('从已确认的源码和制品生成可审阅的业务部署计划，由 LightMoni Agent 执行。', 'Create reviewable deployment plans from confirmed source and releases; LightMoni Agent executes them.')}</p></div><Space><Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>{t('刷新', 'Refresh')}</Button>{user.role === 'admin' && <Button type="primary" icon={<PlusOutlined />} onClick={() => setServiceModal(true)}>{t('新建服务', 'New service')}</Button>}</Space></div>
    {error && <Alert type="error" showIcon closable onClose={() => setError('')} title={error} />}
    {loading && !detail ? <Spin /> : <div className="lm-deployments-layout">
      <Card title={t('业务服务', 'Services')} extra={services.length ? <Select aria-label={t('选择服务', 'Select service')} value={selectedID} options={serviceOptions} onChange={selectService} style={{ minWidth: 180 }} /> : undefined}>
        {!services.length ? <Empty description={t('尚未登记业务服务', 'No services registered')} /> : <Table<Service> size="small" rowKey="id" dataSource={services} pagination={false} onRow={item => ({ onClick: () => void selectService(item.id), style: { cursor: 'pointer' } })} rowClassName={item => item.id === selectedID ? 'lm-deployment-row-selected' : ''} columns={[{ title: t('名称', 'Name'), dataIndex: 'name' }, { title: t('更新时间', 'Updated'), dataIndex: 'updated_at', render: value => value ? new Date(value).toLocaleString(language) : '—' }]} />}
      </Card>
      {!detail ? <Card><Empty description={t('选择服务开始管理目标和部署', 'Select a service to manage targets and deployments')} /></Card> : <>
        <Card title={<Space><CloudUploadOutlined />{detail.service.name}</Space>} extra={user.role === 'admin' && <Space><Button size="small" onClick={() => openTargetEditor()}>{t('添加目标', 'Add target')}</Button><Button size="small" onClick={() => setReleaseModal(true)}>{t('登记制品', 'Register release')}</Button></Space>}>
          <Typography.Paragraph type="secondary">{detail.service.description || t('未填写服务描述', 'No service description')}</Typography.Paragraph>
          <Divider>{t('目标与制品', 'Targets and releases')}</Divider>
          <Descriptions size="small" column={1} items={[{ key: 'repo', label: t('源码地址', 'Repository'), children: detail.service.repository_url || '—' }, { key: 'targets', label: t('部署目标', 'Targets'), children: detail.targets.length ? <Space direction="vertical" style={{ width: '100%' }}>{detail.targets.map(target => {
            const probe = target.preflight;
            const snapshot = probe?.snapshot.preflight;
            const diagnostic = snapshot ? [
              `${t('systemd', 'systemd')}: ${snapshot.systemd_available ? t('可用', 'available') : t('不可用', 'unavailable')}`,
              `${t('Unit', 'Unit')}: ${snapshot.unit_exists ? t('已加载', 'loaded') : t('未加载', 'not loaded')} · ${snapshot.active_state || 'unknown'} · ${snapshot.unit_file_state || 'unknown'}`,
              `${t('当前版本', 'Current version')}: ${snapshot.current_version || '—'}`,
              `${t('受控目录', 'Managed directory')}: ${snapshot.filesystem_check_supported ? `${snapshot.release_directory_exists ? t('存在', 'exists') : t('不存在', 'missing')} · ${snapshot.release_directory_writable ? t('可写', 'writable') : t('不可写', 'not writable')}` : t('当前 Agent 平台不支持安全检查', 'Secure directory checks are unsupported on this Agent platform')}`,
              ...(probe?.expires_at ? [`${t('有效期至', 'Expires')}: ${new Date(probe.expires_at).toLocaleString(language)}`] : []),
            ].join(' | ') : '';
            return <div key={target.id} style={{ width: '100%' }}>
              <Space wrap>
                <Tag>{target.machine_name || target.machine_id} · {target.adapter} · {String(target.config.unit || '')}</Tag>
                {probe && <Tag color={probe.current ? (probe.ready ? 'success' : 'error') : 'default'}>{probe.status === 'completed' ? (probe.current ? (probe.ready ? t('预检通过', 'Preflight ready') : t('预检未通过', 'Preflight not ready')) : t('预检已过期或目标已变更', 'Preflight expired or target changed')) : statusName(probe.status)}</Tag>}
                {user.role === 'admin' && <Button size="small" onClick={() => openTargetEditor(target)}>{t('编辑目标', 'Edit target')}</Button>}
                {user.role === 'admin' && <Button size="small" loading={preflighting === target.id} disabled={!target.config.unit || !target.config.release_directory} onClick={() => void preflight(target)}>{t('只读预检', 'Read-only preflight')}</Button>}
                {detail.releases.length > 0 && <Select aria-label={t('选择部署版本', 'Select release')} size="small" style={{ minWidth: 180 }} value={releaseSelection[target.id] || detail.releases[0]?.id} options={detail.releases.map(release => ({ value: release.id, label: release.version }))} onChange={value => setReleaseSelection(current => ({ ...current, [target.id]: value }))} />}
                {user.role === 'admin' && detail.releases.length > 0 && <Button size="small" loading={busy} onClick={() => void plan(target.id, releaseSelection[target.id] || detail.releases[0]!.id)}>{t('生成计划', 'Create plan')}</Button>}
              </Space>
              {diagnostic && <Typography.Paragraph type="secondary" style={{ margin: '4px 0 0', fontSize: 12 }}>{diagnostic}</Typography.Paragraph>}
              {probe?.error_code && <Typography.Text type="danger">{t('预检错误码', 'Preflight error')}: {probe.error_code}</Typography.Text>}
            </div>;
          })}</Space> : t('尚未添加目标', 'No targets registered') }, { key: 'releases', label: t('制品版本', 'Releases'), children: detail.releases.length ? detail.releases.map(release => <Tag key={release.id}>{release.version} · {release.artifact_digest ? release.artifact_digest.slice(0, 12) : t('无摘要', 'no digest')}</Tag>) : t('尚未登记制品', 'No releases yet') }]} />
          {detail.targets.some(target => target.preflight?.current && target.preflight.ready) && <Alert type="info" showIcon style={{ marginTop: 12 }} title={t('主机预检已通过，制品分发仍未接入', 'Host preflight passed; artifact delivery is not connected yet')} description={t('当前预检只读检查 systemd unit 和受控目录。制品上传与 Agent 下载能力完成前，业务部署计划仍不能审批执行。', 'This preflight only reads the systemd unit and managed directory. Deployment plans remain non-executable until artifact upload and Agent download are implemented.')} />}
        </Card>
        <Card title={t('部署计划', 'Deployment plans')} extra={<Typography.Text type="secondary">{t('计划不会直接执行主机操作', 'Plans do not execute host actions directly')}</Typography.Text>}>
          <Table<Deployment> size="small" rowKey="id" dataSource={detail.deployments} loading={loading} scroll={{ x: 940 }} locale={{ emptyText: <Empty description={t('尚未生成部署计划', 'No deployment plans yet')} /> }} columns={[{ title: t('状态', 'Status'), dataIndex: 'status', render: (_: string, deployment: Deployment) => <Tag color={statusColor[deployment.status] || 'default'}>{deploymentStatusName(deployment)}</Tag> }, { title: t('目标', 'Target'), dataIndex: 'target_id', render: value => detail.targets.find(item => item.id === value)?.machine_name || value }, { title: t('制品', 'Release'), dataIndex: 'release_id', render: value => detail.releases.find(item => item.id === value)?.version || value }, { title: t('创建时间', 'Created'), dataIndex: 'created_at', render: value => value ? new Date(value).toLocaleString(language) : '—' }, { title: t('操作', 'Actions'), fixed: 'right', render: (_: unknown, deployment) => <Space><Button size="small" onClick={() => void selectDeployment(deployment)}>{t('查看时间线', 'View timeline')}</Button>{user.role === 'admin' && deployment.status === 'awaiting_approval' && canApprove(deployment) && <Button size="small" type="primary" loading={busy} onClick={() => void approve(deployment)}>{t('批准', 'Approve')}</Button>}{user.role === 'admin' && ['awaiting_approval', 'agent_ready'].includes(deployment.status) && <Popconfirm title={t('取消此部署计划？', 'Cancel this deployment plan?')} description={deployment.status === 'agent_ready' ? t('仅当 Agent 尚未领取任务时可以取消；若已领取，系统会拒绝取消并要求检查主机。', 'Cancellation is allowed only before the Agent claims the job. If it has claimed the job, the request will be rejected and the host must be checked.'):t('尚未批准的部署计划将被标记为已取消。', 'The unapproved deployment plan will be marked cancelled.')} okText={t('确认取消', 'Confirm cancel')} cancelText={t('返回', 'Back')} onConfirm={() => void cancel(deployment)}><Button size="small" danger loading={busy}>{t('取消', 'Cancel')}</Button></Popconfirm>}{user.role === 'admin' && ['succeeded', 'failed', 'running'].includes(deployment.status) && <Button size="small" danger loading={busy} onClick={() => void rollback(deployment)}>{t('回滚提案', 'Rollback proposal')}</Button>}</Space> }]} />
        </Card>
        {selectedDeployment && <Card title={<Space><SafetyCertificateOutlined />{t('执行时间线', 'Execution timeline')}<Tag color={statusColor[selectedDeployment.status] || 'default'}>{deploymentStatusName(selectedDeployment)}</Tag></Space>}>
          <Alert type="info" showIcon title={t('审批边界', 'Approval boundary')} description={t('批准只允许已在线 Agent 获取后续任务；当前页面不会直接执行 SSH、Shell 或主机命令。健康检查通过表示 Agent 已回报计划中的检查通过，中心遥测仍未验证。', 'Approval only allows an online Agent to receive the next job. This page never executes SSH, Shell, or host commands. A passed health check means the Agent reported its planned check succeeded; central telemetry remains unverified.')} />
          {selectedDeployment.status === 'awaiting_approval' && !canApprove(selectedDeployment) && <Alert type="warning" showIcon title={t('此计划当前不可执行', 'This plan cannot be executed yet')} description={selectedDeployment.plan.provider_plan_reason === 'artifact_transport_required' ? t('Agent 主机预检已通过，但制品上传和受限下载尚未接入；因此系统没有生成可执行部署动作，不能审批执行。', 'Agent host preflight passed, but artifact upload and constrained download are not connected. No executable deployment actions were generated, so this plan cannot be approved.') : t('请先为目标 Agent 执行只读 systemd 预检。预检不会修改主机；制品分发尚未接入，因此计划仍不能审批执行。', 'Run a read-only systemd preflight for the target Agent first. It does not change the host; artifact delivery is not connected, so the plan still cannot be approved.')} />}
          {selectedDeployment.receipt?.state === 'unknown' && <Alert type="warning" showIcon title={t('部署结果待确认', 'Deployment result needs review')} description={selectedDeployment.receipt.summary || t('Agent 未能确认目标主机当前状态，请检查主机后再决定是否重试。', 'The Agent could not confirm the target host state. Inspect the host before deciding whether to retry.')} />}
          {selectedDeployment.status === 'succeeded' && <Alert type="success" showIcon title={t('Agent 健康检查已通过', 'Agent health check passed')} description={t('该状态不代表中心已确认新遥测写入；遥测验证目前尚未接入此部署流程。', 'This status does not confirm that new telemetry reached the center. Telemetry verification is not yet connected to this deployment flow.')} />}
          <Table<Event> size="small" rowKey="id" dataSource={events} pagination={false} columns={[{ title: t('时间', 'Time'), dataIndex: 'created_at', render: value => value ? new Date(value).toLocaleString(language) : '—' }, { title: t('阶段', 'Phase'), dataIndex: 'phase', render: value => statusName(value) }, { title: t('结果', 'Result'), dataIndex: 'summary' }, { title: t('错误码', 'Error code'), dataIndex: 'code', render: value => value || '—' }]} />
        </Card>}
      </>}
    </div>}
    <Modal title={t('新建业务服务', 'New service')} open={serviceModal} onCancel={() => setServiceModal(false)} footer={null} destroyOnHidden><Form form={serviceForm} layout="vertical" onFinish={createService}><Form.Item name="name" label={t('服务名称', 'Service name')} rules={[{ required: true }]}><Input /></Form.Item><Form.Item name="description" label={t('描述', 'Description')}><Input.TextArea rows={3} /></Form.Item><Form.Item name="repository_url" label={t('源码地址（可选）', 'Repository URL (optional)')}><Input /></Form.Item><Button type="primary" htmlType="submit" loading={busy}>{t('创建', 'Create')}</Button></Form></Modal>
    <Modal title={editingTarget ? t('编辑服务目标', 'Edit service target') : t('添加服务目标', 'Add service target')} open={targetModal} onCancel={() => { setTargetModal(false); setEditingTarget(undefined); }} footer={null} destroyOnHidden><Form form={targetForm} layout="vertical" onFinish={saveTarget}>{!editingTarget && <Form.Item name="machine_id" label={t('主机', 'Machine')} rules={[{ required: true }]}><Select showSearch options={machineOptions} placeholder={t('选择已登记主机', 'Select a registered machine')} /></Form.Item>}<Form.Item label={t('部署适配器', 'Deployment adapter')}><Input value="systemd" disabled /></Form.Item><Form.Item name="unit" label={t('systemd Unit', 'systemd unit')} rules={[{ required: true }]}><Input placeholder="my-service.service" /></Form.Item><Form.Item name="release_directory" label={t('受控 Release 目录', 'Managed release directory')} rules={[{ required: true }]}><Input placeholder="/opt/lightmoni/services/my-service" /></Form.Item><Alert type="info" showIcon title={t('Agent 要求', 'Agent requirement')} description={t('需要目标 Agent 最近 180 秒内有心跳。预检只读检查登记的 unit 和目录，不会安装、创建目录或重启服务。配置变化后旧预检自动失效。', 'The target Agent must have checked in within 180 seconds. Preflight only reads the registered unit and directory; it will not install, create directories, or restart services. Changing target configuration invalidates previous preflight results.')} /><Button type="primary" htmlType="submit" loading={busy}>{editingTarget ? t('保存修改', 'Save changes') : t('保存目标', 'Save target')}</Button></Form></Modal>
    <Modal title={t('登记制品版本', 'Register release')} open={releaseModal} onCancel={() => setReleaseModal(false)} footer={null} destroyOnHidden><Form form={releaseForm} layout="vertical" onFinish={createRelease}><Form.Item name="version" label={t('版本', 'Version')} rules={[{ required: true }]}><Input placeholder="2026.10.22" /></Form.Item><Form.Item name="source_type" label={t('来源类型', 'Source type')} initialValue="artifact"><Select options={['artifact', 'git', 'container'].map(value => ({ value, label: value }))} /></Form.Item><Form.Item name="source_ref" label={t('来源引用', 'Source reference')} rules={[{ required: true }]}><Input placeholder={t('制品地址或提交引用', 'Artifact URL or commit reference')} /></Form.Item><Form.Item name="artifact_digest" label={t('SHA-256 摘要（推荐）', 'SHA-256 digest (recommended)')}><Input /></Form.Item><Button type="primary" htmlType="submit" loading={busy}>{t('登记', 'Register')}</Button></Form></Modal>
  </div>;
}
