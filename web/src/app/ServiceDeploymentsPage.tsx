import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { CloudUploadOutlined, PlusOutlined, ReloadOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import { Alert, App, Button, Card, Descriptions, Divider, Empty, Form, Input, Modal, Select, Space, Spin, Table, Tag, Typography } from '../shared/ui';
import { api, post } from '../shared/api';
import { useI18n } from '../shared/i18n';
import type { User } from '../shared/types';
import './service-deployments.css';

type Service = { id: string; name: string; description: string; repository_url: string; updated_at: string };
type Machine = { id: string; name: string; address: string; agent_status: string; agent_id: string };
type Target = { id: string; machine_id: string; machine_name: string; adapter: string; config: Record<string, unknown>; status: string; desired_release_id: string };
type Release = { id: string; version: string; source_type: string; source_ref: string; artifact_digest: string; status: string; created_at: string };
type Deployment = { id: string; target_id: string; release_id: string; adapter: string; status: string; phase: string; operation_id: string; plan: Record<string, unknown>; error: string; created_at: string; approved_at: string };
type Event = { id: string; phase: string; state: string; code: string; summary: string; actor: string; created_at: string };
type ServiceDetail = { service: Service; targets: Target[]; releases: Release[]; deployments: Deployment[] };

const statusColor: Record<string, string> = { succeeded: 'success', running: 'processing', agent_ready: 'processing', awaiting_approval: 'warning', failed: 'error', rollback_pending: 'warning', rolled_back: 'default', cancelled: 'default' };

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
  const [releaseModal, setReleaseModal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selectedDeployment, setSelectedDeployment] = useState<Deployment>();
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
  const createTarget = async (values: Record<string, string>) => {
    if (!detail) return; setBusy(true); try { await post(`/services/${encodeURIComponent(detail.service.id)}/targets`, { ...values, config: {} }); setTargetModal(false); targetForm.resetFields(); await load(detail.service.id); void message.success(t('服务目标已保存', 'Service target saved')); } catch (value) { setError(value instanceof Error ? value.message : t('保存服务目标失败', 'Unable to save service target')); } finally { setBusy(false); }
  };
  const createRelease = async (values: Record<string, string>) => {
    if (!detail) return; setBusy(true); try { await post(`/services/${encodeURIComponent(detail.service.id)}/releases`, { ...values, manifest: {} }); setReleaseModal(false); releaseForm.resetFields(); await load(detail.service.id); void message.success(t('制品版本已登记', 'Release registered')); } catch (value) { setError(value instanceof Error ? value.message : t('登记制品失败', 'Unable to register release')); } finally { setBusy(false); }
  };
  const plan = async (targetID: string, releaseID: string) => {
    if (!detail) return; setBusy(true); try { const result = await post<Deployment>(`/services/${encodeURIComponent(detail.service.id)}/deployments/plan`, { target_id: targetID, release_id: releaseID }); setParams({ service: detail.service.id, deployment: result.id }); await load(detail.service.id); void message.success(t('部署计划已生成，等待管理员审批', 'Deployment plan created and awaits administrator approval')); } catch (value) { setError(value instanceof Error ? value.message : t('生成部署计划失败', 'Unable to create deployment plan')); } finally { setBusy(false); }
  };
  const approve = async (deployment: Deployment) => {
    setBusy(true); try { await post(`/deployments/${encodeURIComponent(deployment.id)}/approve`, { confirm: true, expected_state: deployment.status }); await load(detail?.service.id); void message.success(t('部署已批准，等待 Agent 执行', 'Deployment approved; waiting for Agent execution')); } catch (value) { setError(value instanceof Error ? value.message : t('批准部署失败', 'Unable to approve deployment')); } finally { setBusy(false); }
  };
  const rollback = async (deployment: Deployment) => {
    setBusy(true); try { await post(`/deployments/${encodeURIComponent(deployment.id)}/rollback`, { confirm: true, reason: t('管理员从部署工作台请求回滚', 'Rollback requested from deployment workspace') }); await load(detail?.service.id); void message.success(t('已创建回滚提案', 'Rollback proposal created')); } catch (value) { setError(value instanceof Error ? value.message : t('创建回滚提案失败', 'Unable to create rollback proposal')); } finally { setBusy(false); }
  };
  const selectDeployment = async (deployment: Deployment) => { setSelectedDeployment(deployment); setParams({ service: detail?.service.id || '', deployment: deployment.id }); setEvents(await api<Event[]>(`/deployments/${encodeURIComponent(deployment.id)}/events`)); };
  const serviceOptions = useMemo(() => services.map(item => ({ value: item.id, label: item.name })), [services]);
  const machineOptions = machines.map(item => ({ value: item.id, label: `${item.name} · ${item.address} · ${item.agent_status === 'online' ? t('Agent 在线', 'Agent online') : t('Agent 未在线', 'Agent offline')}` }));

  return <div className="lm-page lm-deployments-page">
    <div className="lm-page-heading"><div><h1>{t('服务部署', 'Service deployments')}</h1><p>{t('从已确认的源码和制品生成可审阅的业务部署计划，由 LightMoni Agent 执行。', 'Create reviewable deployment plans from confirmed source and releases; LightMoni Agent executes them.')}</p></div><Space><Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>{t('刷新', 'Refresh')}</Button>{user.role === 'admin' && <Button type="primary" icon={<PlusOutlined />} onClick={() => setServiceModal(true)}>{t('新建服务', 'New service')}</Button>}</Space></div>
    {error && <Alert type="error" showIcon closable onClose={() => setError('')} title={error} />}
    {loading && !detail ? <Spin /> : <div className="lm-deployments-layout">
      <Card title={t('业务服务', 'Services')} extra={services.length ? <Select aria-label={t('选择服务', 'Select service')} value={selectedID} options={serviceOptions} onChange={selectService} style={{ minWidth: 180 }} /> : undefined}>
        {!services.length ? <Empty description={t('尚未登记业务服务', 'No services registered')} /> : <Table<Service> size="small" rowKey="id" dataSource={services} pagination={false} onRow={item => ({ onClick: () => void selectService(item.id), style: { cursor: 'pointer' } })} rowClassName={item => item.id === selectedID ? 'lm-deployment-row-selected' : ''} columns={[{ title: t('名称', 'Name'), dataIndex: 'name' }, { title: t('更新时间', 'Updated'), dataIndex: 'updated_at', render: value => value ? new Date(value).toLocaleString(language) : '—' }]} />}
      </Card>
      {!detail ? <Card><Empty description={t('选择服务开始管理目标和部署', 'Select a service to manage targets and deployments')} /></Card> : <>
        <Card title={<Space><CloudUploadOutlined />{detail.service.name}</Space>} extra={user.role === 'admin' && <Space><Button size="small" onClick={() => setTargetModal(true)}>{t('添加目标', 'Add target')}</Button><Button size="small" onClick={() => setReleaseModal(true)}>{t('登记制品', 'Register release')}</Button></Space>}>
          <Typography.Paragraph type="secondary">{detail.service.description || t('未填写服务描述', 'No service description')}</Typography.Paragraph>
          <Divider>{t('目标与制品', 'Targets and releases')}</Divider>
          <Descriptions size="small" column={1} items={[{ key: 'repo', label: t('源码地址', 'Repository'), children: detail.service.repository_url || '—' }, { key: 'targets', label: t('部署目标', 'Targets'), children: detail.targets.length ? detail.targets.map(target => <Tag key={target.id}>{target.machine_name || target.machine_id} · {target.adapter} · {target.status}</Tag>) : t('尚未添加目标', 'No targets yet') }, { key: 'releases', label: t('制品版本', 'Releases'), children: detail.releases.length ? detail.releases.map(release => <Tag key={release.id}>{release.version} · {release.artifact_digest ? release.artifact_digest.slice(0, 12) : t('无摘要', 'no digest')}</Tag>) : t('尚未登记制品', 'No releases yet') }]} />
        </Card>
        <Card title={t('部署计划', 'Deployment plans')} extra={<Typography.Text type="secondary">{t('计划不会直接执行主机操作', 'Plans do not execute host actions directly')}</Typography.Text>}>
          <Table<Deployment> size="small" rowKey="id" dataSource={detail.deployments} loading={loading} scroll={{ x: 940 }} locale={{ emptyText: <Empty description={t('尚未生成部署计划', 'No deployment plans yet')} /> }} columns={[{ title: t('状态', 'Status'), dataIndex: 'status', render: value => <Tag color={statusColor[value] || 'default'}>{value}</Tag> }, { title: t('目标', 'Target'), dataIndex: 'target_id', render: value => detail.targets.find(item => item.id === value)?.machine_name || value }, { title: t('制品', 'Release'), dataIndex: 'release_id', render: value => detail.releases.find(item => item.id === value)?.version || value }, { title: t('创建时间', 'Created'), dataIndex: 'created_at', render: value => value ? new Date(value).toLocaleString(language) : '—' }, { title: t('操作', 'Actions'), fixed: 'right', render: (_: unknown, deployment) => <Space><Button size="small" onClick={() => void selectDeployment(deployment)}>{t('查看时间线', 'View timeline')}</Button>{user.role === 'admin' && deployment.status === 'awaiting_approval' && <Button size="small" type="primary" loading={busy} onClick={() => void approve(deployment)}>{t('批准', 'Approve')}</Button>}{user.role === 'admin' && ['succeeded', 'failed', 'running'].includes(deployment.status) && <Button size="small" danger loading={busy} onClick={() => void rollback(deployment)}>{t('回滚提案', 'Rollback proposal')}</Button>}</Space> }]} />
        </Card>
        {selectedDeployment && <Card title={<Space><SafetyCertificateOutlined />{t('执行时间线', 'Execution timeline')}<Tag color={statusColor[selectedDeployment.status] || 'default'}>{selectedDeployment.status}</Tag></Space>}>
          <Alert type="info" showIcon title={t('审批边界', 'Approval boundary')} description={t('批准只允许已在线 Agent 获取后续任务；当前页面不会直接执行 SSH、Shell 或主机命令。健康检查和遥测验证完成前，不应把计划视为部署成功。', 'Approval only allows an online Agent to receive the next job. This page never executes SSH, Shell, or host commands. Do not treat the plan as deployed until health and telemetry verification complete.')} />
          <Table<Event> size="small" rowKey="id" dataSource={events} pagination={false} columns={[{ title: t('时间', 'Time'), dataIndex: 'created_at', render: value => value ? new Date(value).toLocaleString(language) : '—' }, { title: t('阶段', 'Phase'), dataIndex: 'phase' }, { title: t('结果', 'Result'), dataIndex: 'summary' }, { title: t('错误码', 'Error code'), dataIndex: 'code', render: value => value || '—' }]} />
        </Card>}
      </>}
    </div>}
    <Modal title={t('新建业务服务', 'New service')} open={serviceModal} onCancel={() => setServiceModal(false)} footer={null} destroyOnHidden><Form form={serviceForm} layout="vertical" onFinish={createService}><Form.Item name="name" label={t('服务名称', 'Service name')} rules={[{ required: true }]}><Input /></Form.Item><Form.Item name="description" label={t('描述', 'Description')}><Input.TextArea rows={3} /></Form.Item><Form.Item name="repository_url" label={t('源码地址（可选）', 'Repository URL (optional)')}><Input /></Form.Item><Button type="primary" htmlType="submit" loading={busy}>{t('创建', 'Create')}</Button></Form></Modal>
    <Modal title={t('添加服务目标', 'Add service target')} open={targetModal} onCancel={() => setTargetModal(false)} footer={null} destroyOnHidden><Form form={targetForm} layout="vertical" onFinish={createTarget}><Form.Item name="machine_id" label={t('主机', 'Machine')} rules={[{ required: true }]}><Select showSearch options={machineOptions} placeholder={t('选择已登记主机', 'Select a registered machine')} /></Form.Item><Form.Item name="adapter" label={t('部署适配器', 'Deployment adapter')} initialValue="systemd"><Select options={[{ value: 'systemd', label: 'systemd' }, { value: 'docker_compose', label: 'Docker Compose（待支持）' }]} /></Form.Item><Alert type="info" showIcon title={t('Agent 要求', 'Agent requirement')} description={t('审批前会检查目标 Agent 最近 180 秒内的心跳；Docker Compose 当前只登记元数据，不会执行。', 'Approval checks for a target Agent heartbeat in the last 180 seconds. Docker Compose is metadata-only and will not execute yet.')} /><Button type="primary" htmlType="submit" loading={busy}>{t('保存目标', 'Save target')}</Button></Form></Modal>
    <Modal title={t('登记制品版本', 'Register release')} open={releaseModal} onCancel={() => setReleaseModal(false)} footer={null} destroyOnHidden><Form form={releaseForm} layout="vertical" onFinish={createRelease}><Form.Item name="version" label={t('版本', 'Version')} rules={[{ required: true }]}><Input placeholder="2026.10.22" /></Form.Item><Form.Item name="source_type" label={t('来源类型', 'Source type')} initialValue="artifact"><Select options={['artifact', 'git', 'container'].map(value => ({ value, label: value }))} /></Form.Item><Form.Item name="source_ref" label={t('来源引用', 'Source reference')} rules={[{ required: true }]}><Input placeholder={t('制品地址或提交引用', 'Artifact URL or commit reference')} /></Form.Item><Form.Item name="artifact_digest" label={t('SHA-256 摘要（推荐）', 'SHA-256 digest (recommended)')}><Input /></Form.Item><Button type="primary" htmlType="submit" loading={busy}>{t('登记', 'Register')}</Button></Form></Modal>
  </div>;
}
