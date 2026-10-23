import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CloudUploadOutlined, PlusOutlined, ReloadOutlined, SafetyCertificateOutlined, UploadOutlined } from '@ant-design/icons';
import { Alert, App, Button, Card, Descriptions, Divider, Empty, Form, Input, Modal, Popconfirm, Select, Space, Spin, Table, Tag, Typography, Upload } from '../shared/ui';
import { api, post } from '../shared/api';
import { useI18n } from '../shared/i18n';
import type { User } from '../shared/types';
import './service-deployments.css';

type Service = { id: string; name: string; description: string; repository_url: string; updated_at: string };
type Machine = { id: string; name: string; address: string; agent_status: string; agent_id: string };
type TargetPreflight = { id: string; status: string; ready: boolean; current: boolean; snapshot: { preflight?: { provider?: string; systemd_available?: boolean; unit_exists?: boolean; active_state?: string; enabled?: boolean | 'unknown'; unit_file_state?: string; filesystem_check_supported?: boolean; entrypoint_matches?: boolean; current_pointer_valid?: boolean; current_version?: string; release_directory_exists?: boolean; release_directory_writable?: boolean; observed_at?: string } }; error_code: string; expires_at: string };
type Target = { id: string; machine_id: string; machine_name: string; adapter: string; config: Record<string, unknown>; status: string; desired_release_id: string; preflight?: TargetPreflight | null };
type Release = { id: string; version: string; source_type: string; source_ref: string; artifact_digest: string; artifact_size?: number; artifact_format?: string; status: string; created_at: string };
type TelemetryBinding = { table: string; service: string; instance_id: string };
type TelemetryResult = { state: 'unconfigured' | 'verified' | 'waiting' | 'timed_out' | 'unavailable' | 'invalid'; stale?: boolean; code: string; selector: TelemetryBinding | null; serviceVersion?: string; observedSamples: number; minSamples: number; from: string; to: string; deadline: string; checkedAt: string };
type Deployment = { id: string; target_id: string; release_id: string; adapter: string; status: string; phase: string; operation_id: string; operation_kind?: string; plan: Record<string, any>; target_snapshot?: { config?: { telemetry?: TelemetryBinding } }; telemetry?: TelemetryResult | null; receipt?: { state?: string; code?: string; summary?: string }; error: string; created_at: string; approved_at: string; finished_at?: string };
type Event = { id: string; phase: string; state: string; code: string; summary: string; actor: string; created_at: string };
type ServiceDetail = { service: Service; targets: Target[]; releases: Release[]; deployments: Deployment[] };

const statusColor: Record<string, string> = { succeeded: 'success', running: 'processing', agent_ready: 'processing', staging: 'processing', activating: 'processing', verifying: 'processing', awaiting_approval: 'warning', failed: 'error', rollback_pending: 'warning', rolling_back: 'processing', rolled_back: 'default', cancelled: 'default' };
const RELEASE_ARTIFACT_MAX_BYTES = 64 * 1024 * 1024;
const RELEASE_ARTIFACT_CONTENT_TYPE = 'application/vnd.lightmoni.release+gzip';

async function sha256(file: File) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

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
  const [uploadFile, setUploadFile] = useState<File>();
  const [uploadRelease, setUploadRelease] = useState<Release>();
  const [uploadError, setUploadError] = useState('');
  const [busy, setBusy] = useState(false);
  const [selectedDeployment, setSelectedDeployment] = useState<Deployment>();
  const selectedDeploymentID = useRef<string | undefined>(undefined);
  const [preflighting, setPreflighting] = useState("");
  const [releaseSelection, setReleaseSelection] = useState<Record<string, string>>({});
  const [serviceForm] = Form.useForm();
  const [targetForm] = Form.useForm();
  const [releaseForm] = Form.useForm();
  const selectedID = params.get('service') || services[0]?.id || '';
  selectedDeploymentID.current = selectedDeployment?.id;

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
    if (!detail) return;
    const table = values.telemetry_table?.trim() || '', service = values.telemetry_service?.trim() || '', instanceID = values.telemetry_instance?.trim() || '';
    if ([table, service, instanceID].some(Boolean) && ![table, service, instanceID].every(Boolean)) {
      const error = t('遥测绑定需同时填写数据表、SDK 服务名和实例 ID；也可以全部留空。', 'Provide the telemetry table, SDK service name, and instance ID together, or leave all three blank.');
      targetForm.setFields([{ name: 'telemetry_table', errors: [error] }]);
      return;
    }
    setBusy(true);
    try {
      const input = { ...(editingTarget ? {} : { machine_id: values.machine_id }), adapter: 'systemd', config: { unit: values.unit, release_directory: values.release_directory, ...(table ? { telemetry: { table, service, instance_id: instanceID } } : {}) } };
      if (editingTarget) await api(`/services/${encodeURIComponent(detail.service.id)}/targets/${encodeURIComponent(editingTarget.id)}`, { method: 'PATCH', body: JSON.stringify(input) });
      else await post(`/services/${encodeURIComponent(detail.service.id)}/targets`, input);
      setTargetModal(false); setEditingTarget(undefined); targetForm.resetFields(); await load(detail.service.id); void message.success(t('服务目标已保存', 'Service target saved'));
    } catch (value) { setError(value instanceof Error ? value.message : t('保存服务目标失败', 'Unable to save service target')); }
    finally { setBusy(false); }
  };
  const openTargetEditor = (target?: Target) => {
    setEditingTarget(target);
    const binding = target?.config.telemetry as TelemetryBinding | undefined;
    targetForm.resetFields();
    targetForm.setFieldsValue({ machine_id: target?.machine_id, unit: target?.config.unit, release_directory: target?.config.release_directory, telemetry_table: binding?.table, telemetry_service: binding?.service, telemetry_instance: binding?.instance_id });
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
  const openReleaseModal = () => { setUploadRelease(undefined); setUploadFile(undefined); setUploadError(''); releaseForm.resetFields(); setReleaseModal(true); };
  const retryReleaseUpload = (release: Release) => { setUploadRelease(release); setUploadFile(undefined); setUploadError(''); releaseForm.resetFields(); setReleaseModal(true); };
  const selectReleaseFile = (file: File) => {
    if (file.name !== 'lightmoni-release-v1.tar.gz') {
      setUploadFile(undefined);
      setUploadError(t('请选择文件名为 lightmoni-release-v1.tar.gz 的制品包。', 'Select a bundle named lightmoni-release-v1.tar.gz.'));
      return Upload.LIST_IGNORE;
    }
    if (!file.size || file.size > RELEASE_ARTIFACT_MAX_BYTES) {
      setUploadFile(undefined);
      setUploadError(t('制品不能为空，压缩包最大为 64 MiB。', 'The bundle cannot be empty and must be no larger than 64 MiB.'));
      return Upload.LIST_IGNORE;
    }
    setUploadError(''); setUploadFile(file);
    return false;
  };
  const createRelease = async (values: Record<string, string>) => {
    if (!detail) return;
    if (!uploadFile) { setUploadError(t('请先选择 lightmoni-release-v1.tar.gz。', 'Choose lightmoni-release-v1.tar.gz first.')); return; }
    if (uploadFile.size > RELEASE_ARTIFACT_MAX_BYTES) { setUploadError(t('制品最大为 64 MiB。', 'The bundle must be no larger than 64 MiB.')); return; }
    if (!globalThis.crypto?.subtle) { setUploadError(t('浏览器需要在 HTTPS 或 localhost 安全环境中运行，才能计算制品摘要。', 'The browser must use a secure context (HTTPS or localhost) to calculate the artifact digest.')); return; }
    setBusy(true); setUploadError('');
    let pendingRelease: Release | undefined;
    try {
      // Keep the pending release ID after upload errors so retry never creates a duplicate release.
      const release = uploadRelease || await post<Release>(`/services/${encodeURIComponent(detail.service.id)}/releases`, { ...values, manifest: {} });
      pendingRelease = release;
      if (!uploadRelease) setUploadRelease(release);
      const digest = await sha256(uploadFile);
      await api(`/services/${encodeURIComponent(detail.service.id)}/releases/${encodeURIComponent(release.id)}/artifact`, {
        method: 'PUT',
        body: uploadFile,
        headers: { 'Content-Type': RELEASE_ARTIFACT_CONTENT_TYPE, 'X-Artifact-Sha256': digest },
      });
      setReleaseModal(false); setUploadRelease(undefined); setUploadFile(undefined); releaseForm.resetFields();
      await load(detail.service.id);
      void message.success(t('制品上传并校验通过；刷新后的就绪版本可用于生成部署计划。', 'Artifact uploaded and verified. The refreshed ready release can now be used to create a deployment plan.'));
    } catch (value) {
      setUploadError(value instanceof Error ? t(`制品上传失败：${value.message}。待上传版本已保留，可选择文件后重试。`, `Artifact upload failed: ${value.message}. The pending release is retained; choose a file and retry.`) : t('制品上传失败。待上传版本已保留，可重新选择文件后重试。', 'Artifact upload failed. The pending release is retained; choose another file and retry.'));
      if (pendingRelease) await load(detail.service.id);
    } finally { setBusy(false); }
  };
  const plan = async (targetID: string, releaseID: string) => {
    if (!detail) return; setBusy(true); try { const result = await post<Deployment>(`/services/${encodeURIComponent(detail.service.id)}/deployments/plan`, { target_id: targetID, release_id: releaseID }); setParams({ service: detail.service.id, deployment: result.id }); await load(detail.service.id); const reason = result.plan.provider_plan_reason; void message.success(reason === 'artifact_missing' || reason === 'artifact_invalid' || reason === 'artifact_architecture_mismatch' || reason === 'agent_architecture_unknown' ? t('计划已生成，但当前制品或 Agent 条件不满足执行要求；请查看计划详情。', 'Plan created, but the artifact or Agent does not meet execution requirements. Review the plan details.') : reason === 'agent_preflight_required' ? t('预览计划已生成；请先完成只读预检，再为最新状态重新生成计划。', 'Preview plan created. Complete read-only preflight, then create a plan from the latest state.') : t('可审阅的部署计划已生成。', 'Reviewable deployment plan created.')); } catch (value) { setError(value instanceof Error ? value.message : t('生成部署计划失败', 'Unable to create deployment plan')); } finally { setBusy(false); }
  };
  const approve = async (deployment: Deployment) => {
    setBusy(true); try { await post(`/deployments/${encodeURIComponent(deployment.id)}/approve`, { confirm: true, expected_state: deployment.status }); await load(detail?.service.id); void message.success(t('部署已批准，等待 Agent 执行', 'Deployment approved; waiting for Agent execution')); } catch (value) { setError(value instanceof Error ? value.message : t('批准部署失败', 'Unable to approve deployment')); } finally { setBusy(false); }
  };
  const cancel = async (deployment: Deployment) => {
    setBusy(true); try { await post(`/deployments/${encodeURIComponent(deployment.id)}/cancel`, { confirm: true, expected_state: deployment.status }); await load(detail?.service.id); void message.success(t('部署计划已取消', 'Deployment plan cancelled')); } catch (value) { setError(value instanceof Error ? value.message : t('取消部署失败', 'Unable to cancel deployment')); } finally { setBusy(false); }
  };
  const rollback = async (deployment: Deployment) => {
    setBusy(true); try { await post(`/deployments/${encodeURIComponent(deployment.id)}/rollback`, { confirm: true, expected_state: deployment.status, reason: t('管理员从部署工作台确认回滚', 'Administrator confirmed rollback from deployment workspace') }); await load(detail?.service.id); void message.success(t('回滚任务已提交给 Agent', 'Rollback job queued for the Agent')); } catch (value) { setError(value instanceof Error ? value.message : t('提交回滚任务失败', 'Unable to queue rollback job')); } finally { setBusy(false); }
  };
  const verifyTelemetry = async (deployment: Deployment) => {
    setBusy(true); setError('');
    try {
      const result = await post<Deployment>(`/deployments/${encodeURIComponent(deployment.id)}/verify-telemetry`, {});
      setDetail(current => current ? { ...current, deployments: current.deployments.map(item => item.id === result.id ? result : item) } : current);
      setSelectedDeployment(current => current?.id === result.id ? result : current);
      const nextEvents = await api<Event[]>(`/deployments/${encodeURIComponent(result.id)}/events`);
      if (selectedDeploymentID.current === result.id) setEvents(nextEvents);
      if (result.telemetry?.state === 'verified' && !result.telemetry.stale) void message.success(t('已发现匹配的部署后遥测', 'Matching post-deployment telemetry found'));
    } catch (value) { setError(value instanceof Error ? value.message : t('核验遥测失败，请刷新部署状态后重试', 'Unable to verify telemetry. Refresh the deployment and retry.')); }
    finally { setBusy(false); }
  };
  const rollbackReady = (deployment: Deployment) => {
    const rollback = deployment.plan.rollback;
    const target = detail?.targets.find(item => item.id === deployment.target_id);
    const preflight = target?.preflight?.snapshot?.preflight;
    return rollback?.available === true && target?.preflight?.current === true
      && target?.preflight?.id !== deployment.plan.preflight_id
      && preflight?.provider === 'systemd' && preflight.systemd_available === true && preflight.unit_exists === true
      && preflight.filesystem_check_supported === true && preflight.release_directory_exists === true && preflight.release_directory_writable === true
      && preflight.entrypoint_matches === true && preflight.current_pointer_valid === true
      && ['active', 'inactive', 'failed'].includes(String(preflight.active_state))
      && !['masked', 'masked-runtime'].includes(String(preflight.unit_file_state))
      && preflight.current_version === deployment.plan.release?.version
      && (deployment.operation_kind !== 'rollback' || deployment.status !== 'failed'
        || Date.parse(String(preflight.observed_at || '')) > Date.parse(String(deployment.finished_at || '')));
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
    if (deployment.plan.provider_plan_reason === 'artifact_missing') return t('等待上传制品', 'Waiting for artifact upload');
    if (deployment.plan.provider_plan_reason === 'artifact_invalid') return t('制品校验未通过', 'Artifact validation failed');
    if (deployment.plan.provider_plan_reason === 'artifact_architecture_mismatch') return t('制品架构不匹配', 'Artifact architecture mismatch');
    if (deployment.plan.provider_plan_reason === 'agent_architecture_unknown') return t('Agent 架构未知', 'Agent architecture unknown');
    if (deployment.plan.provider_plan_reason === 'agent_preflight_required') {
      const preflight = deployment.plan.preflight as TargetPreflight | undefined;
      if (preflight?.status === 'queued' || preflight?.status === 'running') return t('Agent 预检进行中', 'Agent preflight running');
      if (preflight?.status === 'failed' || preflight?.status === 'unknown' || preflight?.status === 'expired' || (preflight?.status === 'completed' && (!preflight.current || !preflight.ready))) return t('需重新执行预检', 'Preflight must be repeated');
      return t('需运行只读预检', 'Read-only preflight required');
    }
    return t('暂不可审批', 'Approval unavailable');
  };
  const telemetry = selectedDeployment?.telemetry;
  const telemetryBinding = telemetry?.selector || selectedDeployment?.target_snapshot?.config?.telemetry;
  const telemetryStateName = telemetry?.stale ? t('核验结果已过期', 'Verification result is stale') : telemetry ? ({
    unconfigured: t('未配置遥测绑定', 'Telemetry binding not configured'),
    verified: t('匹配遥测已核验', 'Matching telemetry verified'),
    waiting: t('暂未发现匹配数据', 'Waiting for matching data'),
    timed_out: t('等待窗口已结束，遥测未验证', 'Window ended; telemetry unverified'),
    unavailable: t('遥测查询暂不可用', 'Telemetry query unavailable'),
    invalid: t('遥测绑定或结果无效', 'Invalid telemetry binding or result'),
  }[telemetry.state]) : t('尚未核验', 'Not checked');
  const formatTime = (value?: string) => value ? new Date(value).toLocaleString(language) : '—';

  return <div className="lm-page lm-deployments-page">
    <div className="lm-page-heading"><div><h1>{t('服务部署', 'Service deployments')}</h1><p>{t('从已确认的源码和制品生成可审阅的业务部署计划，由 LightMoni Agent 执行。', 'Create reviewable deployment plans from confirmed source and releases; LightMoni Agent executes them.')}</p></div><Space><Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>{t('刷新', 'Refresh')}</Button>{user.role === 'admin' && <Button type="primary" icon={<PlusOutlined />} onClick={() => setServiceModal(true)}>{t('新建服务', 'New service')}</Button>}</Space></div>
    {error && <Alert type="error" showIcon closable onClose={() => setError('')} title={error} />}
    {loading && !detail ? <Spin /> : <div className="lm-deployments-layout">
      <Card title={t('业务服务', 'Services')} extra={services.length ? <Select aria-label={t('选择服务', 'Select service')} value={selectedID} options={serviceOptions} onChange={selectService} style={{ minWidth: 180 }} /> : undefined}>
        {!services.length ? <Empty description={t('尚未登记业务服务', 'No services registered')} /> : <Table<Service> size="small" rowKey="id" dataSource={services} pagination={false} onRow={item => ({ onClick: () => void selectService(item.id), style: { cursor: 'pointer' } })} rowClassName={item => item.id === selectedID ? 'lm-deployment-row-selected' : ''} columns={[{ title: t('名称', 'Name'), dataIndex: 'name' }, { title: t('更新时间', 'Updated'), dataIndex: 'updated_at', render: value => value ? new Date(value).toLocaleString(language) : '—' }]} />}
      </Card>
      {!detail ? <Card><Empty description={t('选择服务开始管理目标和部署', 'Select a service to manage targets and deployments')} /></Card> : <>
        <Card title={<Space><CloudUploadOutlined />{detail.service.name}</Space>} extra={user.role === 'admin' && <Space><Button size="small" onClick={() => openTargetEditor()}>{t('添加目标', 'Add target')}</Button><Button size="small" onClick={openReleaseModal}>{t('上传制品', 'Upload artifact')}</Button></Space>}>
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
                {detail.releases.some(release => release.status === 'ready') && <Select aria-label={t('选择部署版本', 'Select release')} size="small" style={{ minWidth: 180 }} value={detail.releases.some(release => release.id === releaseSelection[target.id] && release.status === 'ready') ? releaseSelection[target.id] : detail.releases.find(release => release.status === 'ready')?.id} options={detail.releases.filter(release => release.status === 'ready').map(release => ({ value: release.id, label: release.version }))} onChange={value => setReleaseSelection(current => ({ ...current, [target.id]: value }))} />}
                {user.role === 'admin' && detail.releases.some(release => release.status === 'ready') && <Button size="small" loading={busy} onClick={() => { const ready = detail.releases.find(release => release.id === releaseSelection[target.id] && release.status === 'ready') || detail.releases.find(release => release.status === 'ready'); if (ready) void plan(target.id, ready.id); }}>{t('生成计划', 'Create plan')}</Button>}
              </Space>
              {diagnostic && <Typography.Paragraph type="secondary" style={{ margin: '4px 0 0', fontSize: 12 }}>{diagnostic}</Typography.Paragraph>}
              {target.config.telemetry != null && <Typography.Paragraph type="secondary" style={{ margin: '4px 0 0', fontSize: 12 }}>{t('已配置部署后遥测绑定', 'Post-deployment telemetry binding configured')}: {String((target.config.telemetry as TelemetryBinding).table)} · {String((target.config.telemetry as TelemetryBinding).service)} · {String((target.config.telemetry as TelemetryBinding).instance_id)}</Typography.Paragraph>}
              {probe?.error_code && <Typography.Text type="danger">{t('预检错误码', 'Preflight error')}: {probe.error_code}</Typography.Text>}
            </div>;
          })}</Space> : t('尚未添加目标', 'No targets registered') }, { key: 'releases', label: t('制品版本', 'Releases'), children: detail.releases.length ? <Space direction="vertical" style={{ width: '100%' }}>{detail.releases.map(release => <Space key={release.id} wrap><Tag color={release.status === 'ready' ? 'success' : release.status === 'pending_artifact' ? 'warning' : 'error'}>{release.version} · {release.status === 'ready' ? t('就绪', 'Ready') : release.status === 'pending_artifact' ? t('待上传', 'Pending upload') : release.status}</Tag>{release.artifact_digest && <Typography.Text code>{release.artifact_digest.slice(0, 12)}…</Typography.Text>}{release.status === 'pending_artifact' && user.role === 'admin' && <Button size="small" onClick={() => retryReleaseUpload(release)}>{t('上传 / 重试', 'Upload / retry')}</Button>}</Space>)}</Space> : t('尚未上传制品', 'No artifacts uploaded yet') }]} />
          {detail.releases.some(release => release.status !== 'ready') && <Alert type="info" showIcon style={{ marginTop: 12 }} title={t('仅就绪制品可用于部署计划', 'Only ready artifacts can be used in deployment plans')} description={t('上传 lightmoni-release-v1.tar.gz 后，中心会校验 SHA-256、归属和 manifest。上传成功并刷新后，版本才会出现在部署选择列表中。', 'After uploading lightmoni-release-v1.tar.gz, the center validates its SHA-256, ownership, and manifest. A release appears in deployment selectors only after upload succeeds and the list refreshes.')} />}
        </Card>
        <Card title={t('部署计划', 'Deployment plans')} extra={<Typography.Text type="secondary">{t('计划不会直接执行主机操作', 'Plans do not execute host actions directly')}</Typography.Text>}>
          <Table<Deployment> size="small" rowKey="id" dataSource={detail.deployments} loading={loading} scroll={{ x: 940 }} locale={{ emptyText: <Empty description={t('尚未生成部署计划', 'No deployment plans yet')} /> }} columns={[{ title: t('状态', 'Status'), dataIndex: 'status', render: (_: string, deployment: Deployment) => <Tag color={statusColor[deployment.status] || 'default'}>{deploymentStatusName(deployment)}</Tag> }, { title: t('目标', 'Target'), dataIndex: 'target_id', render: value => detail.targets.find(item => item.id === value)?.machine_name || value }, { title: t('制品', 'Release'), dataIndex: 'release_id', render: value => detail.releases.find(item => item.id === value)?.version || value }, { title: t('创建时间', 'Created'), dataIndex: 'created_at', render: value => value ? new Date(value).toLocaleString(language) : '—' }, { title: t('操作', 'Actions'), fixed: 'right', render: (_: unknown, deployment) => <Space><Button size="small" onClick={() => void selectDeployment(deployment)}>{t('查看时间线', 'View timeline')}</Button>{user.role === 'admin' && deployment.status === 'awaiting_approval' && canApprove(deployment) && <Button size="small" type="primary" loading={busy} onClick={() => void approve(deployment)}>{t('批准', 'Approve')}</Button>}{user.role === 'admin' && ['awaiting_approval', 'agent_ready'].includes(deployment.status) && <Popconfirm title={t('取消此部署计划？', 'Cancel this deployment plan?')} description={deployment.status === 'agent_ready' ? t('仅当 Agent 尚未领取任务时可以取消；若已领取，系统会拒绝取消并要求检查主机。', 'Cancellation is allowed only before the Agent claims the job. If it has claimed the job, the request will be rejected and the host must be checked.'):t('尚未批准的部署计划将被标记为已取消。', 'The unapproved deployment plan will be marked cancelled.')} okText={t('确认取消', 'Confirm cancel')} cancelText={t('返回', 'Back')} onConfirm={() => void cancel(deployment)}><Button size="small" danger loading={busy}>{t('取消', 'Cancel')}</Button></Popconfirm>}{user.role === 'admin' && ['succeeded', 'failed'].includes(deployment.status) && deployment.plan.rollback?.available === true && <Popconfirm title={t(`回滚到版本 ${deployment.plan.rollback.previous_version}？`, `Roll back to ${deployment.plan.rollback.previous_version}?`)} description={rollbackReady(deployment) ? t('Agent 将先用 CAS 确认当前仍为本次部署版本，再恢复旧版、重启并执行健康检查。', 'The Agent will confirm the deployed version with CAS, restore the previous release, restart it, and run a health check.') : t('请先对该目标执行只读预检；只有 current version 仍是本次部署版本时才能回滚。', 'Run read-only preflight first. Rollback is allowed only while the current version is still this deployment.')} okText={t('确认回滚', 'Confirm rollback')} cancelText={t('返回', 'Back')} disabled={!rollbackReady(deployment)} onConfirm={() => void rollback(deployment)}><Button size="small" danger loading={busy} disabled={!rollbackReady(deployment)}>{t(`回滚到 ${deployment.plan.rollback.previous_version}`, `Roll back to ${deployment.plan.rollback.previous_version}`)}</Button></Popconfirm>}</Space> }]} />
        </Card>
        {selectedDeployment && <Card title={t('部署后遥测核验', 'Post-deployment telemetry verification')} extra={user.role === 'admin' && selectedDeployment.status === 'succeeded' && selectedDeployment.operation_kind !== 'rollback' && <Button loading={busy} disabled={telemetry?.stale === true} onClick={() => void verifyTelemetry(selectedDeployment)}>{telemetry ? t('重新核验', 'Check again') : t('核验遥测', 'Verify telemetry')}</Button>}>
          <Alert
            showIcon
            type={telemetry?.stale ? 'warning' : telemetry?.state === 'verified' ? 'success' : ['timed_out', 'invalid', 'unconfigured'].includes(telemetry?.state || '') ? 'warning' : 'info'}
            title={telemetryStateName}
            description={telemetry?.stale
              ? t('目标配置、部署或回滚状态已变化，此结果仅保留为历史记录。请查看当前部署；变更绑定后需要重新预检并生成新计划。', 'The target, deployment, or rollback state changed. This result is historical. Review the current deployment; changing a binding requires a new preflight and plan.')
              : !telemetryBinding
                ? t('此部署快照没有遥测绑定。可在编辑目标中配置业务数据表、SDK 服务名和实例 ID，再预检并生成新计划；旧部署快照不会随目标编辑改变。', 'This deployment snapshot has no telemetry binding. Edit the target to set a business table, SDK service name, and instance ID, then run preflight and create a new plan. Existing deployment snapshots do not change with target edits.')
                : telemetry?.state === 'unavailable'
                  ? t('未能完成有界只读查询，可手动重试。查询异常不会改变 Agent 健康检查结论，也不会触发回滚。', 'The bounded read-only query could not complete. Retry manually. Query errors do not change Agent health results or trigger rollback.')
                  : telemetry?.state === 'invalid'
                    ? t('请检查绑定的公开业务数据表和 SDK 标识。修改目标配置后，需重新预检并生成新计划。', 'Check the public business table and SDK identifiers. After editing the target, run preflight and create a new plan.')
                    : selectedDeployment.status !== 'succeeded' || selectedDeployment.operation_kind === 'rollback'
                      ? t('仅 Agent 健康检查已通过的普通部署可发起核验。', 'Verification is available only for a normal deployment that passed Agent health checks.')
                      : t('管理员手动查询部署完成后五分钟内的匹配数据，并留一分钟接收缓冲。没有数据可手动重试，窗口保持不变；此结果不会触发自动回滚。', 'Administrators manually check matching data from the five minutes after completion, with a one-minute delivery buffer. Retry manually if no data is found; the window stays fixed. Verification never triggers automatic rollback.')}
          />
          <Descriptions size="small" column={1} items={[
            { key: 'table', label: t('业务公开表', 'Public business table'), children: telemetryBinding?.table || '—' },
            { key: 'service', label: 'SDK service.name', children: telemetryBinding?.service || '—' },
            { key: 'instance', label: 'SDK service.instance.id', children: telemetryBinding?.instance_id || '—' },
            { key: 'version', label: 'SDK service.version', children: telemetry?.serviceVersion || selectedDeployment.plan.release?.version || detail.releases.find(item => item.id === selectedDeployment.release_id)?.version || '—' },
            { key: 'samples', label: t('匹配样本数（上限 1000）', 'Matching samples (up to 1000)'), children: telemetry ? String(telemetry.observedSamples) : '—' },
            { key: 'window', label: t('固定观察窗口（结束不含）', 'Fixed observation window (end exclusive)'), children: telemetry?.from && telemetry.to ? `${formatTime(telemetry.from)} — ${formatTime(telemetry.to)}` : '—' },
            { key: 'deadline', label: t('接收缓冲截止', 'Delivery buffer deadline'), children: formatTime(telemetry?.deadline) },
            { key: 'checked', label: t('上次核验', 'Last checked'), children: formatTime(telemetry?.checkedAt) },
            { key: 'code', label: t('结果码', 'Result code'), children: telemetry?.code || '—' },
          ]} />
          <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>{t('SDK 必须显式设置上述服务名、稳定实例 ID 和发布版本。核验仅证明部署完成后身份、版本与时间匹配的数据已入库；不证明部署因果关系，也不校验 SDK 身份不可伪造。启动与健康检查之前的数据不计入。', 'The SDK must explicitly set this service name, stable instance ID, and release version. Verification only proves that matching post-deployment data reached storage; it does not prove deployment causality or unforgeable SDK identity. Data from startup and before health-check completion does not count.')}</Typography.Paragraph>
        </Card>}
        {selectedDeployment && <Card title={<Space><SafetyCertificateOutlined />{t('执行时间线', 'Execution timeline')}<Tag color={statusColor[selectedDeployment.status] || 'default'}>{deploymentStatusName(selectedDeployment)}</Tag></Space>}>
          <Alert type="info" showIcon title={t('审批边界', 'Approval boundary')} description={t('批准只允许已在线 Agent 获取后续任务；当前页面不会直接执行 SSH、Shell 或主机命令。健康检查表示 Agent 已回报计划中的检查通过；中心遥测核验结果单独展示。', 'Approval only allows an online Agent to receive the next job. This page never executes SSH, Shell, or host commands. Health checks reflect the Agent\'s planned checks; central telemetry verification is shown separately.')} />
          {selectedDeployment.status === 'awaiting_approval' && !canApprove(selectedDeployment) && <Alert type="warning" showIcon title={t('此计划当前不可执行', 'This plan cannot be executed yet')} description={selectedDeployment.plan.provider_plan_reason === 'artifact_missing' ? t('该版本还没有成功上传制品。上传并校验 lightmoni-release-v1.tar.gz 后，请为就绪版本重新生成计划。', 'This release has no successfully uploaded artifact. Upload and validate lightmoni-release-v1.tar.gz, then create a new plan for the ready release.') : selectedDeployment.plan.provider_plan_reason === 'artifact_invalid' ? t('制品或 manifest 校验失败。请查看该版本状态，必要时重新登记版本并上传正确的制品包。', 'Artifact or manifest validation failed. Review the release status; if needed, register a new release and upload a valid bundle.') : selectedDeployment.plan.provider_plan_reason === 'artifact_architecture_mismatch' ? t('制品架构与目标 Agent 不匹配，请为该架构上传对应版本。', 'Artifact architecture does not match the target Agent. Upload a bundle for the matching architecture.') : selectedDeployment.plan.provider_plan_reason === 'agent_architecture_unknown' ? t('中心无法确认 Agent 架构，请先更新 Agent 并刷新节点状态。', 'The Agent architecture is unknown. Update the Agent and refresh node status first.') : selectedDeployment.plan.provider_plan_reason === 'agent_preflight_required' ? t('请先为目标 Agent 执行只读 systemd 预检，完成后基于最新状态重新生成计划。', 'Run a read-only systemd preflight for the target Agent, then create a plan using the latest state.') : t('计划未生成可执行部署动作，请检查目标预检、版本状态和计划详情。', 'No executable deployment actions were generated. Review target preflight, release status, and plan details.')} />}
          {selectedDeployment.receipt?.state === 'unknown' && <Alert type="warning" showIcon title={t('部署结果待确认', 'Deployment result needs review')} description={selectedDeployment.receipt.summary || t('Agent 未能确认目标主机当前状态，请检查主机后再决定是否重试。', 'The Agent could not confirm the target host state. Inspect the host before deciding whether to retry.')} />}
          {selectedDeployment.status === 'succeeded' && <Alert type="success" showIcon title={t('Agent 健康检查已通过', 'Agent health check passed')} description={t('业务健康状态与遥测核验结果独立。请在部署后遥测核验中查看是否已有匹配数据到达中心。', 'Business health and telemetry verification are independent. Check post-deployment telemetry verification to see whether matching data reached the center.')} />}
          {['succeeded', 'failed'].includes(selectedDeployment.status) && selectedDeployment.plan.rollback?.available !== true && <Alert type="info" showIcon title={t('没有可自动恢复的已登记版本', 'No registered previous release is available')} description={selectedDeployment.plan.rollback?.reason === 'no_previous_release' ? t('这是该目标的首次部署。请修复后创建新部署，或人工检查主机；平台不会猜测或覆盖未登记版本。', 'This is the first deployment for this target. Create a corrective deployment or inspect the host manually; the platform will not guess or overwrite an unregistered release.') : t('部署前的 current version 没有关联到同一业务服务的就绪 release；请人工检查主机。', 'The pre-deployment current version is not linked to a ready release for this service. Inspect the host manually.')} />}
          {['succeeded', 'failed'].includes(selectedDeployment.status) && selectedDeployment.plan.rollback?.available === true && !rollbackReady(selectedDeployment) && <Alert type="warning" showIcon title={t('回滚前需要新的安全预检', 'Run a fresh safe preflight before rollback')} description={t(`请在目标列表中执行只读预检，确认 unit、受控目录和入口安全，且 current version 仍为 ${selectedDeployment.plan.release?.version}。即使服务处于 failed 状态，只要受控目标检查通过也可以尝试恢复。`, `Run read-only preflight for the target. Confirm the unit, managed directory, and entrypoint are safe and current version remains ${selectedDeployment.plan.release?.version}. A failed service state is allowed when the controlled target checks pass.`)} />}
          {selectedDeployment.status === 'rolled_back' && <Alert type="success" showIcon title={t('已恢复 previous release', 'Previous release restored')} description={t(`Agent 已恢复版本 ${selectedDeployment.plan.rollback?.previous_version} 并回报 systemd 健康检查通过。`, `Agent restored version ${selectedDeployment.plan.rollback?.previous_version} and reported a passing systemd health check.`)} />}
          <Table<Event> size="small" rowKey="id" dataSource={events} pagination={false} columns={[{ title: t('时间', 'Time'), dataIndex: 'created_at', render: value => value ? new Date(value).toLocaleString(language) : '—' }, { title: t('阶段', 'Phase'), dataIndex: 'phase', render: value => statusName(value) }, { title: t('结果', 'Result'), dataIndex: 'summary' }, { title: t('错误码', 'Error code'), dataIndex: 'code', render: value => value || '—' }]} />
        </Card>}
      </>}
    </div>}
    <Modal title={t('新建业务服务', 'New service')} open={serviceModal} onCancel={() => setServiceModal(false)} footer={null} destroyOnHidden><Form form={serviceForm} layout="vertical" onFinish={createService}><Form.Item name="name" label={t('服务名称', 'Service name')} rules={[{ required: true }]}><Input /></Form.Item><Form.Item name="description" label={t('描述', 'Description')}><Input.TextArea rows={3} /></Form.Item><Form.Item name="repository_url" label={t('源码地址（可选）', 'Repository URL (optional)')}><Input /></Form.Item><Button type="primary" htmlType="submit" loading={busy}>{t('创建', 'Create')}</Button></Form></Modal>
    <Modal title={editingTarget ? t('编辑服务目标', 'Edit service target') : t('添加服务目标', 'Add service target')} open={targetModal} onCancel={() => { setTargetModal(false); setEditingTarget(undefined); }} footer={null} destroyOnHidden>
      <Form form={targetForm} layout="vertical" onFinish={saveTarget} disabled={busy}>
        {!editingTarget && <Form.Item name="machine_id" label={t('主机', 'Machine')} rules={[{ required: true }]}><Select showSearch options={machineOptions} placeholder={t('选择已登记主机', 'Select a registered machine')} /></Form.Item>}
        <Form.Item label={t('部署适配器', 'Deployment adapter')}><Input value="systemd" disabled /></Form.Item>
        <Form.Item name="unit" label={t('systemd Unit', 'systemd unit')} rules={[{ required: true }]}><Input placeholder="my-service.service" /></Form.Item>
        <Form.Item name="release_directory" label={t('受控 Release 目录', 'Managed release directory')} rules={[{ required: true }]}><Input placeholder="/opt/lightmoni/services/my-service" /></Form.Item>
        <Divider>{t('部署后遥测绑定（可选）', 'Post-deployment telemetry binding (optional)')}</Divider>
        <Typography.Paragraph type="secondary">{t('三项需一起填写；全部留空则不配置。绑定会随部署计划固定，修改后需要重新预检并生成计划。', 'Fill all three fields together, or leave all blank. The binding is fixed in each deployment plan; changes require a new preflight and plan.')}</Typography.Paragraph>
        <Form.Item name="telemetry_table" label={t('业务公开数据表', 'Public business table')} extra={t('使用数据目录中的规范公开业务表名，例如 log_orders、trace_orders 或 metric_orders_sum；不支持系统表。目录和必需列在核验时检查。', 'Use a canonical public business table from the data catalog, such as log_orders, trace_orders, or metric_orders_sum. System tables are not supported. The catalog and required columns are checked during verification.')}><Input maxLength={100} placeholder="log_orders" onChange={() => targetForm.setFields([{ name: 'telemetry_table', errors: [] }])} /></Form.Item>
        <Form.Item name="telemetry_service" label="SDK service.name" extra={t('填写 SDK 实际配置的服务名，不是平台服务 ID。', 'Use the service name configured in the SDK, not the platform service ID.')}><Input maxLength={256} placeholder="orders-api" /></Form.Item>
        <Form.Item name="telemetry_instance" label="SDK service.instance.id" extra={t('填写该目标上 SDK 的稳定实例 ID，且让 SDK service.version 与发布版本完全一致；平台不会自动注入。', 'Use the SDK’s stable instance ID on this target. SDK service.version must exactly match the release version; the platform does not inject it automatically.')}><Input maxLength={128} placeholder="orders-node-01" /></Form.Item>
        <Alert type="info" showIcon title={t('Agent 要求', 'Agent requirement')} description={t('需要目标 Agent 最近 180 秒内有心跳。目录需由 root 预先创建并设为 root:lightmoni-agent（建议权限 0775），加入 lightmoni-agent.service 的 ReadWritePaths；业务服务用户只读且不能属于 Agent 组。预检只读检查登记的 unit 和目录，不会安装、创建目录或重启服务。配置变化后旧预检自动失效。', 'The Agent must have checked in within 180 seconds. Pre-create the directory as root with owner/group root:lightmoni-agent (mode 0775 recommended), add the exact path to lightmoni-agent.service ReadWritePaths, and keep the business service user read-only and outside the Agent group. Preflight only checks the registered unit and directory; it will not install, create directories, or restart services. Changing target configuration invalidates previous preflight results.')} />
        <Button type="primary" htmlType="submit" loading={busy}>{editingTarget ? t('保存修改', 'Save changes') : t('保存目标', 'Save target')}</Button>
      </Form>
    </Modal>
    <Modal title={uploadRelease ? t(`上传制品 · ${uploadRelease.version}`, `Upload artifact · ${uploadRelease.version}`) : t('登记版本并上传制品', 'Register release and upload artifact')} open={releaseModal} onCancel={() => { if (busy) return; setReleaseModal(false); }} footer={null} destroyOnHidden>
      <Form form={releaseForm} layout="vertical" onFinish={createRelease} disabled={busy}>
        {uploadRelease ? <Alert type="info" showIcon title={t('待上传版本已保留', 'Pending release retained')} description={t(`版本 ${uploadRelease.version} 尚未就绪。重新选择制品上传即可继续，不会重复创建版本。`, `Release ${uploadRelease.version} is not ready. Choose a bundle to retry; no duplicate release will be created.`)} /> : <>
          <Form.Item name="version" label={t('版本', 'Version')} rules={[{ required: true }]}><Input placeholder="2026.10.22" /></Form.Item>
          <Form.Item name="source_type" label={t('来源类型', 'Source type')} initialValue="artifact"><Select options={['artifact', 'git', 'container'].map(value => ({ value, label: value }))} /></Form.Item>
          <Form.Item name="source_ref" label={t('来源 / 构建引用', 'Source / build reference')} extra={t('填写源码提交、构建编号或制品来源说明。', 'Enter a source commit, build number, or artifact provenance.')} rules={[{ required: true }]}><Input placeholder={t('例如：main@a1b2c3d 或 build-2026.10.22', 'e.g. main@a1b2c3d or build-2026.10.22')} /></Form.Item>
        </>}
        <Form.Item label={t('业务制品包', 'Application bundle')} required>
          <Upload accept=".tar.gz,application/gzip" maxCount={1} disabled={busy} fileList={uploadFile ? [{ uid: 'release-artifact', name: uploadFile.name, status: 'done' }] : []} beforeUpload={file => selectReleaseFile(file)} onRemove={() => { setUploadFile(undefined); setUploadError(''); return true; }}>
            <Button icon={<UploadOutlined />} disabled={busy}>{uploadFile ? t('更换制品包', 'Choose another bundle') : t('选择 lightmoni-release-v1.tar.gz', 'Choose lightmoni-release-v1.tar.gz')}</Button>
          </Upload>
          {uploadFile && <Typography.Paragraph type="secondary" style={{ margin: '8px 0 0' }}>{uploadFile.name} · {(uploadFile.size / (1024 * 1024)).toFixed(2)} MiB</Typography.Paragraph>}
        </Form.Item>
        <Alert type="warning" showIcon title={t('制品不得包含密钥或环境凭据', 'Bundles must not contain keys or environment credentials')} description={t('仅接受 lightmoni-release-v1.tar.gz，最大 64 MiB。中心会校验摘要、USTAR gzip、manifest 和常见凭据路径/内容；启发式扫描不能保证发现所有秘密。请只打包运行文件，并通过目标主机的独立秘密管理注入凭据。无效包不会就绪。上传不会构建、部署或启动服务；网络流量可能产生费用。', 'Only lightmoni-release-v1.tar.gz is accepted, up to 64 MiB. The center validates the digest, USTAR gzip, manifest, and common credential paths/content; heuristic scanning cannot guarantee discovery of every secret. Package runtime files only and inject credentials separately through secret management on the target host. Invalid bundles will not become ready. Uploading does not build, deploy, or start the service. Network transfer may incur charges.')} />
        {uploadError && <Alert type="error" showIcon title={uploadError} style={{ marginTop: 12 }} />}
        <Button type="primary" htmlType="submit" loading={busy} disabled={!uploadFile}>{uploadRelease ? t('上传 / 重试', 'Upload / retry') : t('登记并上传', 'Register and upload')}</Button>
      </Form>
    </Modal>
  </div>;
}
