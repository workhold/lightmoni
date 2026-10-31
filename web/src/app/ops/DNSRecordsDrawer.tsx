import {useCallback, useEffect, useRef, useState} from 'react';
import {PlusOutlined, ReloadOutlined} from '@ant-design/icons';
import {Alert, App, Button, Checkbox, Drawer, Empty, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Switch, Table, Tag, Typography} from '../../shared/ui';
import {api} from '../../shared/api';
import {useI18n} from '../../shared/i18n';
import {errorText, type Resource, type Spec} from './model';
import {batchItems, DNS_BATCH_LIMIT, DNS_TYPES, dnsOutcome, executeDNSBatch, recordID, splitValues, type BatchAction, type BatchItem, type BatchState, type DNSResponse} from './dns-batch';

type Batch = {action: BatchAction; zone: Resource; records: Spec[]};

export default function DNSRecordsDrawer({zone, onClose, onRefresh}: {zone?: Resource; onClose: () => void; onRefresh: () => Promise<void>}) {
  const {t} = useI18n(), {message} = App.useApp();
  const [records, setRecords] = useState<Spec[]>([]), [total, setTotal] = useState(0), [page, setPage] = useState(1);
  const [keyword, setKeyword] = useState(''), [loading, setLoading] = useState(false), [error, setError] = useState('');
  const [selection, setSelection] = useState<Map<string, Spec>>(new Map());
  const [editor, setEditor] = useState<{record?: Spec}>(), [form] = Form.useForm(), [busy, setBusy] = useState(false);
  const [batch, setBatch] = useState<Batch>(), [batchForm] = Form.useForm(), [items, setItems] = useState<BatchItem[]>();
  const [running, setRunning] = useState(false), [stopping, setStopping] = useState(false), [batchError, setBatchError] = useState('');
  const pending = useRef(false), stop = useRef(false), request = useRef(0), mounted = useRef(true);
  useEffect(() => {mounted.current = true; return () => {mounted.current = false; stop.current = true; request.current++;};}, []);
  const batchValues = Form.useWatch([], batchForm) ?? {};
  const zoneID = zone?.id;

  useEffect(() => {setRecords([]); setTotal(0); setPage(1); setKeyword(''); setSelection(new Map()); setError(''); setEditor(undefined); setBatch(undefined);}, [zoneID]);
  const loadRecords = useCallback(async () => {
    const current = ++request.current;
    if (!zoneID) return;
    setLoading(true);
    try {
      const data = await api<{records: Spec[]; total: number}>('/ops/resources/' + encodeURIComponent(zoneID) + '/records?offset=' + ((page - 1) * 20) + '&limit=20&keyword=' + encodeURIComponent(keyword));
      if (current !== request.current) return;
      const last = Math.max(1, Math.ceil(data.total / 20));
      if (page > last) {setPage(last); return true;}
      setRecords(data.records ?? []); setTotal(data.total ?? 0);
      // Refresh snapshots on this page without dropping selected rows on other pages.
      setSelection(previous => new Map([...previous].map(([id, record]) => [id, data.records.find(r => recordID(r) === id) ?? record])));
      return true;
    } catch (e) {if (current === request.current) setError(errorText(e)); return false;}
    finally {if (current === request.current) setLoading(false);}
  }, [zoneID, page, keyword]);
  useEffect(() => {void loadRecords(); return () => {request.current++;};}, [loadRecords]);
  const locked = busy || running;

  useEffect(() => {
    if (!editor) return;
    form.resetFields(); form.setFieldsValue({name: '@', type: 'A', ttl: 600, enabled: true, ...editor.record});
  }, [editor, form]);
  useEffect(() => {
    if (!batch) return;
    batchForm.resetFields();
    batchForm.setFieldsValue(batch.action === 'create_record' ? {name: '@', type: 'A', ttl: 600, enabled: true, values: ''} : {changeType: true, changeValue: true});
  }, [batch, batchForm]);

  async function singleAction(action: string, input: Spec) {
    if (!zone || pending.current) return;
    pending.current = true; setBusy(true); setError('');
    if (action === 'sync') setSelection(new Map());
    try {
      const response = await api<DNSResponse>('/ops/resources/' + encodeURIComponent(zone.id) + '/actions', {method: 'POST', body: JSON.stringify({revision: zone.revision, confirmed: true, action, input})});
      const outcome = dnsOutcome(response);
      await Promise.all([onRefresh(), loadRecords()]);
      if (['failed', 'unknown'].includes(outcome.state)) throw Error((outcome.state === 'unknown' ? t('结果未知，请先同步核对：', 'Unknown result. Synchronize and inspect records: ') : '') + (outcome.detail || t('DNS 执行失败', 'DNS operation failed')));
      setEditor(undefined); setSelection(new Map());
      if (outcome.state === 'verifying') void message.info(t('平台已接受请求，请同步记录确认结果。', 'Provider accepted the request. Synchronize records to confirm.'));
      else void message.success(t('DNS 请求已执行，请核对回读记录', 'DNS request executed; review the returned records'));
    } catch (e) {setError(errorText(e));}
    finally {pending.current = false; setBusy(false);}
  }
  function saveRecord(values: Spec) {
    const record = {...editor?.record, ...values};
    if (editor?.record) record.id = recordID(editor.record);
    if (values.line !== editor?.record?.line) delete record.line_id;
    if (record.line === '') delete record.line;
    return singleAction(editor?.record ? 'update_record' : 'create_record', {record});
  }
  function openBatch(action: BatchAction) {
    if (!zone || locked) return;
    setBatch({action, zone: {...zone}, records: [...selection.values()].map(record => ({...record}))});
    setItems(undefined); setBatchError(''); setStopping(false);
  }
  async function execute(values: Spec) {
    if (!batch || pending.current || items) return;
    let targets: BatchItem[];
    try {targets = batchItems(batch.action, batch.records, values);}
    catch (e) {setBatchError(errorText(e) === 'dns_batch_fields_required' ? t('至少选择一个要修改的字段。', 'Select at least one field to change.') : t('每批需要 1–50 条记录。', 'Each batch requires 1–50 records.')); return;}
    pending.current = true; stop.current = false; setRunning(true); setItems(targets); setBatchError(''); setError('');
    try {
      const results = await executeDNSBatch(targets, item => api<DNSResponse>('/ops/resources/' + encodeURIComponent(batch.zone.id) + '/actions', {
        method: 'POST', body: JSON.stringify({revision: batch.zone.revision, confirmed: true, action: batch.action, input: batch.action === 'delete_record' ? {id: recordID(item.record)} : {record: item.record}}),
      }), setItems, () => stop.current);
      if (!mounted.current) return;
      const succeeded = new Set(results.filter(item => item.state === 'succeeded').map(item => item.key));
      if (batch.action !== 'create_record') setSelection(previous => new Map([...previous].filter(([id]) => !succeeded.has(id))));
      const [, refreshed] = await Promise.all([onRefresh(), loadRecords()]);
      if (refreshed === false) setBatchError(t('记录刷新失败，请关闭后同步核对；逐条执行结果已保留。', 'Record refresh failed. Close and synchronize to inspect; individual results are preserved.'));
    } catch (e) {setBatchError(errorText(e));}
    finally {pending.current = false; setRunning(false);}
  }

  let preview: BatchItem[] = [];
  try {if (batch) preview = batchItems(batch.action, batch.records, batchValues, false);} catch {/* Validation appears on submission. */}
  const rows = items ?? preview;
  const labels: Record<BatchState, [string, string]> = {waiting: ['待处理', 'Waiting'], running: ['执行中', 'Running'], succeeded: ['成功', 'Succeeded'], failed: ['失败', 'Failed'], verifying: ['待回读', 'Awaiting verification'], unknown: ['结果未知', 'Unknown result'], skipped: ['未执行', 'Not started']};
  const statusTag = (state: BatchState) => <Tag color={state === 'succeeded' ? 'success' : state === 'failed' ? 'error' : state === 'unknown' || state === 'verifying' ? 'warning' : state === 'running' ? 'processing' : undefined}>{t(...labels[state])}</Tag>;
  const title = batch?.action === 'create_record' ? t('批量创建解析记录', 'Create DNS records in bulk') : batch?.action === 'update_record' ? t('批量修改解析记录', 'Edit DNS records in bulk') : t('批量删除解析记录', 'Delete DNS records in bulk');
  const typeOptions = DNS_TYPES.map(value => ({value, label: value}));
  const valueRules = [{required: true, message: t('请填写记录值', 'Enter a record value')}, {max: 4096, message: t('记录值最多 4096 个字符', 'Record values support up to 4096 characters')}, {pattern: /^[^\r\n\0]+$/, message: t('每条记录值不能包含换行或空字符', 'Each record value must be a single line without null characters')}];
  const commonFields = <>
    <div className="lm-ops-grid"><Form.Item name="name" label={t('主机记录', 'Record name')} rules={[{required: true}]}><Input placeholder="www / @"/></Form.Item><Form.Item name="type" label={t('记录类型', 'Record type')} rules={[{required: true}]}><Select options={typeOptions}/></Form.Item></div>
    <div className="lm-ops-grid"><Form.Item name="ttl" label="TTL" rules={[{required: true}]}><InputNumber min={1} max={604800}/></Form.Item><Form.Item name="line" label={t('线路（可选）', 'Line (optional)')}><Input placeholder={t('留空使用平台默认线路', 'Blank uses provider default')}/></Form.Item><Form.Item name="priority" label={t('优先级（MX / SRV）', 'Priority (MX / SRV)')}><InputNumber min={0} max={65535}/></Form.Item><Form.Item name="enabled" label={t('启用', 'Enabled')} valuePropName="checked"><Switch/></Form.Item></div>
  </>;

  const batchFooter = <div className="lm-ops-modal-actions"><Button disabled={running} onClick={() => setBatch(undefined)}>{items ? t('关闭', 'Close') : t('取消', 'Cancel')}</Button>
            {running ? <Button disabled={stopping} onClick={() => {stop.current = true; setStopping(true);}}>{stopping ? t('正在停止后续…', 'Stopping remaining…') : t('停止后续', 'Stop remaining')}</Button> : !items && <Button type="primary" danger={batch?.action === 'delete_record'} htmlType="submit" form="lm-dns-batch-form">{batch?.action === 'delete_record' ? t('确认删除', 'Confirm deletion') : batch?.action === 'create_record' ? t('确认创建', 'Confirm creation') : t('确认修改', 'Confirm changes')}</Button>}
          </div>;

  return <>
    <Drawer open={!!zone} title={zone ? t('解析记录', 'DNS records') + ' · ' + zone.spec.domain : ''} size={1060} onClose={() => {if (!locked) onClose();}} closable={!locked} maskClosable={!locked} keyboard={!locked}>
      <div className="lm-ops-section-heading"><div><p className="lm-ops-note">{t('平台接受修改后仍需等待 DNS 缓存传播。', 'Provider acceptance is separate from DNS cache propagation.')}</p><small>{t('管理范围', 'Scope')}: {zone?.spec.scope ?? zone?.spec.domain}</small></div><Space wrap>
        <Input.Search key={zoneID} placeholder={t('搜索主机名或记录值', 'Search name or record value')} aria-label={t('搜索 DNS 记录', 'Search DNS records')} allowClear disabled={locked || !!batch} onSearch={value => {setSelection(new Map()); setKeyword(value); setPage(1);}} style={{width: 200}}/>
        <Button icon={<ReloadOutlined aria-hidden/>} loading={busy} disabled={running || !!batch} onClick={() => void singleAction('sync', {})}>{t('同步记录', 'Sync records')}</Button>
        <Button disabled={locked || !!batch} onClick={() => openBatch('create_record')}>{t('批量创建', 'Bulk create')}</Button>
        <Button type="primary" icon={<PlusOutlined aria-hidden/>} disabled={locked || !!batch} onClick={() => {setEditor({}); setError('');}}>{t('新增记录', 'Add record')}</Button>
      </Space></div>
      {error && !editor && <Alert type="error" showIcon title={t('DNS 操作或刷新失败', 'DNS operation or refresh failed')} description={error}/>}
      <Space wrap style={{marginBottom: 12}}><span aria-live="polite">{t('已选择', 'Selected') + ' ' + selection.size + ' / ' + DNS_BATCH_LIMIT}</span>
        <Button disabled={!selection.size || locked || !!batch} onClick={() => openBatch('update_record')}>{t('批量修改', 'Bulk edit')}</Button>
        <Button danger disabled={!selection.size || locked || !!batch} onClick={() => openBatch('delete_record')}>{t('批量删除', 'Bulk delete')}</Button>
        <Button type="text" disabled={!selection.size || locked || !!batch} onClick={() => setSelection(new Map())}>{t('清空选择', 'Clear selection')}</Button>
      </Space>
      <Table<Spec> rowKey={record => recordID(record) || record.name + '-' + record.type + '-' + record.value} size="small" dataSource={records} loading={loading}
        rowSelection={{selectedRowKeys: [...selection.keys()], preserveSelectedRowKeys: true,
          getCheckboxProps: record => ({disabled: loading || locked || !!batch || !recordID(record) || (selection.size >= DNS_BATCH_LIMIT && !selection.has(recordID(record)))}),
          onChange: (_keys, selectedRows) => setSelection(new Map(selectedRows.filter(record => recordID(record)).slice(0, DNS_BATCH_LIMIT).map(record => [recordID(record), record]))),
        }} pagination={{current: page, pageSize: 20, total, showSizeChanger: false, disabled: locked || !!batch, onChange: setPage}} scroll={{x: 900}} columns={[
          {title: t('主机记录', 'Name'), dataIndex: 'name'}, {title: t('类型', 'Type'), dataIndex: 'type'},
          {title: t('记录值', 'Value'), dataIndex: 'value', render: value => <Typography.Text className="lm-ops-record-value" copyable>{value}</Typography.Text>},
          {title: 'TTL', dataIndex: 'ttl'}, {title: t('线路', 'Line'), dataIndex: 'line'},
          {title: t('状态', 'State'), render: (_, record) => record.enabled === false ? <Tag>{t('已停用', 'Disabled')}</Tag> : <Tag color="success">{t('已启用', 'Enabled')}</Tag>},
          {title: t('操作', 'Actions'), render: (_, record) => <Space size={2}>
            <Button size="small" disabled={locked || !!batch} onClick={() => {setEditor({record}); setError('');}}>{t('编辑', 'Edit')}</Button>
            <Popconfirm title={t('确认切换记录状态？', 'Change record status?')} onConfirm={() => singleAction('set_record_status', {id: recordID(record), enabled: record.enabled === false})}><Button size="small" disabled={locked || !!batch}>{record.enabled === false ? t('启用', 'Enable') : t('停用', 'Disable')}</Button></Popconfirm>
            <Popconfirm title={t('确认删除此 DNS 记录？', 'Delete this DNS record?')} onConfirm={() => singleAction('delete_record', {id: recordID(record)})}><Button size="small" danger type="text" disabled={locked || !!batch}>{t('删除', 'Delete')}</Button></Popconfirm>
          </Space>},
        ]} locale={{emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('尚无记录，请先同步平台现状', 'No records loaded. Synchronize the provider first.')}/>}}/>
    </Drawer>

    <Modal open={!!editor} title={editor?.record ? t('编辑解析记录', 'Edit DNS record') : t('新增解析记录', 'Add DNS record')} footer={null} width={640} onCancel={() => {if (!busy) setEditor(undefined);}} destroyOnHidden>
      {error && <Alert type="error" showIcon title={t('保存失败，输入已保留', 'Save failed; input preserved')} description={error}/>}
      <Form form={form} layout="vertical" className="lm-ops-form" disabled={busy} onFinish={saveRecord}>
        {commonFields}<Form.Item name="value" label={t('记录值', 'Record value')} rules={valueRules}><Input.TextArea rows={3}/></Form.Item>
        <div className="lm-ops-footer"><Button onClick={() => setEditor(undefined)} disabled={busy}>{t('取消', 'Cancel')}</Button><Button type="primary" htmlType="submit" loading={busy}>{t('保存并更新 DNS', 'Save and update DNS')}</Button></div>
      </Form>
    </Modal>

    <Modal open={!!batch} title={title} width={900} footer={batchFooter} onCancel={() => {if (!running) setBatch(undefined);}} closable={!running} mask={{closable: !running}} keyboard={!running} destroyOnHidden style={{top: 24}} styles={{body: {maxHeight: 'calc(100dvh - 210px)', overflowY: 'auto'}}}>
      {batch && <>
        <p>{batch.zone.spec.domain} · {t('配置版本', 'Revision')} {batch.zone.revision}</p>
        <Alert showIcon type={batch.action === 'delete_record' ? 'warning' : 'info'} title={batch.action === 'delete_record' ? t('确认后逐条删除以下记录', 'Confirm deletion of the following records') : t('确认后逐条提交以下记录', 'Confirm submission of the following records')} description={t('单批最多 50 条，逐条执行。结果未知或待回读时请先同步核对，勿重复提交；关闭页面会停止后续记录。DNS 缓存传播仍需等待 TTL。', 'Up to 50 records execute sequentially. Synchronize unknown or unverified results before resubmitting. Leaving the page stops remaining records. DNS caches still require TTL propagation.')}/>
        {batchError && <Alert showIcon type="error" title={batchError}/>}
        <Form id="lm-dns-batch-form" form={batchForm} layout="vertical" disabled={running || !!items} onFinish={execute} style={{marginTop: 16}}>
          {batch.action === 'create_record' && <>{commonFields}<Form.Item name="values" label={t('记录值（每行一个 value）', 'Record values (one value per line)')} extra={t('空行会忽略，完全相同的 value 仅创建一次。', 'Blank lines are ignored; identical values are created once.')} rules={[{validator: (_, value) => {const values = splitValues(value ?? ''); return values.length > 0 && values.length <= DNS_BATCH_LIMIT && values.every(value => value.length <= 4096 && !/[\r\0]/.test(value)) ? Promise.resolve() : Promise.reject(Error(t('请输入 1–50 个不同 value，每个最多 4096 字符。', 'Enter 1–50 distinct values, up to 4096 characters each.')));}}]}><Input.TextArea rows={5} placeholder={'203.0.113.10\n203.0.113.11'}/></Form.Item></>}
          {batch.action === 'update_record' && <>
            <Form.Item name="changeType" valuePropName="checked"><Checkbox>{t('修改解析类型', 'Change record type')}</Checkbox></Form.Item>
            {batchValues.changeType && <Form.Item name="type" label={t('新解析类型', 'New record type')} rules={[{required: true}]}><Select options={typeOptions}/></Form.Item>}
            <Form.Item name="changeValue" valuePropName="checked"><Checkbox>{t('修改记录值', 'Change record value')}</Checkbox></Form.Item>
            {batchValues.changeValue && <Form.Item name="value" label={t('新记录值', 'New record value')} rules={valueRules}><Input.TextArea rows={3}/></Form.Item>}
          </>}
        </Form>
          <p aria-live="polite">{t('本次记录数', 'Records in this batch')}: {rows.length}{items && <> · {Object.keys(labels).map(state => {const count = items.filter(item => item.state === state).length; return count ? <span key={state}>{statusTag(state as BatchState)} {count} </span> : null;})}</>}</p>
          <Table<BatchItem> rowKey="key" size="small" dataSource={rows} pagination={false} scroll={{x: 650, y: 260}} columns={[
            {title: t('主机记录', 'Name'), dataIndex: ['record', 'name'], width: 110},
            {title: t('类型', 'Type'), width: 100, render: (_, item) => <>{item.original && item.original.type !== item.record.type ? item.original.type + ' → ' : ''}{item.record.type ?? '—'}</>},
            {title: t('记录值', 'Value'), width: 230, render: (_, item) => <div style={{overflowWrap: 'anywhere', whiteSpace: 'pre-wrap'}}>{item.original && item.original.value !== item.record.value && <><Typography.Text type="secondary">{item.original.value}</Typography.Text><br/>→ </>}{item.record.value ?? '—'}</div>},
            {title: t('线路', 'Line'), width: 100, render: (_, item) => item.record.line ?? t('默认', 'Default')},
            {title: t('结果', 'Result'), width: 150, render: (_, item) => <>{statusTag(item.state)}{item.detail && <small style={{display: 'block', overflowWrap: 'anywhere'}}>{item.detail}</small>}{['unknown', 'verifying'].includes(item.state) && <small>{t('请同步核对后再操作', 'Synchronize and inspect before repeating')}</small>}</>},
          ]}/>

      </>}
    </Modal>
  </>;
}
