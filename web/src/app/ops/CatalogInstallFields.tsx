import {useEffect,useRef} from 'react';
import {PlusOutlined,DeleteOutlined} from '@ant-design/icons';
import {Alert,Button,Checkbox,Collapse,Form,Input,InputNumber,Select} from '../../shared/ui';
import {useI18n} from '../../shared/i18n';
import {ClusterManagementLink} from './ClusterFields';
import type {CatalogTemplate,Machine,Resource,Spec} from './model';

export default function CatalogInstallFields({template,resources,machines,advanced,onAdvanced}:{template:CatalogTemplate;resources:Resource[];machines:Machine[];advanced:boolean;onAdvanced:(open:boolean)=>void}){
 const {t}=useI18n(),form=Form.useFormInstance();
 const placements:Spec[]=Form.useWatch(['spec','deployments'],form)??[];
 const mode=Form.useWatch(['spec','deployment_mode'],form);
 const portEdited=useRef(false),containerPort=template.spec?.ports?.[0]?.container_port;
 const gateway=template.id==='openresty';
 useEffect(()=>{
  if(!portEdited.current&&containerPort&&!gateway)form.setFieldValue(['parameters','port'],mode==='managed'?undefined:containerPort);
 },[mode,containerPort,form,gateway]);
 const clusters=resources.filter(r=>r.kind==='cluster');
 useEffect(()=>{
  const rows:Spec[]=form.getFieldValue(['spec','deployments'])??[];
  let changed=false;
  const next=rows.map(row=>{
   const value={...row};
   if(!value.cluster_id&&clusters.length===1){value.cluster_id=clusters[0].id;changed=true}
   const cluster=clusters.find(c=>c.id===value.cluster_id);
   const available=machines.filter(m=>cluster?.spec.machine_ids?.includes(m.id)&&m.agent_id&&m.agent_status==='online');
   if(mode==='manual'&&!value.machine_ids?.length&&available.length===1){value.machine_ids=[available[0].id];changed=true}
   return value;
  });
  if(changed)form.setFieldValue(['spec','deployments'],next);
 },[resources,machines,form,mode]);
 function parameter(p:NonNullable<CatalogTemplate['parameters']>[number]){
  const labels:Record<string,[string,string]>={password:[gateway?'密码':template.id==='mysql'?'Root 密码':'访问密码','Password'],user_password:['应用用户密码','Application user password'],database:['数据库','Database'],user:['应用用户','Application user'],port:['端口','Port']};
  return <Form.Item key={p.key} name={['parameters',p.key]} label={labels[p.key]?t(...labels[p.key]):p.label} rules={p.required?[{required:true,message:t('请填写此参数','Enter this parameter')}]:[]} extra={p.key==='port'?(mode==='managed'?t('留空由平台分配，填写后使用指定端口','Leave blank for platform allocation; enter a value to use that port'):t('默认使用容器端口，可修改；0 表示自动分配','Defaults to the container port; change it or use 0 for automatic allocation')):undefined}>{p.type==='number'?<InputNumber min={0} max={65535} placeholder={mode==='managed'?t('平台自动分配','Assigned by platform'):String(containerPort??'')} onChange={()=>{if(p.key==='port')portEdited.current=true}}/>:p.type==='password'||p.type==='secret'?<Input.Password autoComplete="new-password"/>:<Input/>}</Form.Item>;
 }
 return <><Form.List name={['spec','deployments']} rules={[{validator:(_,rows)=>rows?.length?Promise.resolve():Promise.reject(Error(t('请选择安装位置','Choose an installation target')))}]}>{(fields,{remove},meta)=><>
  {fields.map(f=>{
   const row=placements[f.name]??{},cluster=clusters.find(c=>c.id===row.cluster_id);
   const allowed=machines.filter(m=>cluster?.spec.machine_ids?.includes(m.id));
   return <div key={f.key} className="lm-install-target">
    {fields.length>1&&<div className="lm-ops-subheading"><strong>{t('安装位置','Installation target')} {f.name+1}</strong><Button danger type="text" icon={<DeleteOutlined/>} onClick={()=>remove(f.name)}>{t('移除','Remove')}</Button></div>}
    <Form.Item name={[f.name,'cluster_id']} label={t('部署集群','Deployment cluster')} rules={[{required:true,message:t('请选择集群','Choose a cluster')}]} extra={<ClusterManagementLink/>}><Select showSearch optionFilterProp="label" placeholder={t('选择安装位置','Choose an installation target')} options={clusters.map(c=>({value:c.id,label:c.name,disabled:placements.some((p,i)=>i!==f.name&&p.cluster_id===c.id)}))} onChange={id=>{const selected=clusters.find(c=>c.id===id);const online=machines.filter(m=>selected?.spec.machine_ids?.includes(m.id)&&m.agent_id&&m.agent_status==='online');form.setFieldValue(['spec','deployments',f.name,'machine_ids'],online.length===1?[online[0].id]:[])}}/></Form.Item>
    {mode==='managed'?<Form.Item name={[f.name,'replicas']} label={t('实例数量','Instances')} rules={[{required:true}]}><InputNumber min={1} max={100}/></Form.Item>:<Form.Item name={[f.name,'machine_ids']} label={t('部署机器','Deployment machines')} rules={[{required:true,message:t('请选择部署机器','Choose deployment machines')}]}><Select mode="multiple" showSearch optionFilterProp="label" disabled={!row.cluster_id} placeholder={t('选择在线机器','Choose online machines')} options={allowed.map(m=>({value:m.id,disabled:!m.agent_id||m.agent_status!=='online',label:m.name+(m.agent_status!=='online'?' · '+t('离线','Offline'):!m.agent_id?' · '+t('未接入 Agent','No Agent'):'')}))}/></Form.Item>}
    {gateway&&<Form.Item name={[f.name,'gateway_domain']} label={t('集群入口域名','Cluster entry domain')} extra={t('可稍后设置，网站 CNAME 将指向此域名','Can be set later; website CNAME records point here')}><Input placeholder="edge.example.com"/></Form.Item>}
    {mode==='managed'&&template.spec?.stateful&&<Form.Item name={[f.name,'stateful_acknowledged']} valuePropName="checked" rules={[{validator:(_,v)=>v?Promise.resolve():Promise.reject(Error(t('请确认本地数据限制','Acknowledge the local data limitation')))}]}><Checkbox>{t('我已处理数据可达性；不会自动迁移本地数据或建立复制。','I have addressed data access; local data is not migrated or replicated automatically.')}</Checkbox></Form.Item>}
   </div>;
  })}
  <Form.ErrorList errors={meta.errors}/>
 </>}</Form.List>
  <div className="lm-ops-grid">{(template.parameters??[]).filter(p=>p.required||p.key==='port').map(parameter)}</div>
  {gateway&&<p className="lm-ops-note">{t('使用宿主机 80 / 443 端口，请确保端口空闲。','Uses host ports 80 / 443. Ensure they are available.')}</p>}
  <Collapse className="lm-install-advanced" activeKey={advanced?['advanced']:[]} onChange={keys=>onAdvanced(keys.includes('advanced'))} items={[{key:'advanced',label:t('高级设置','Advanced settings'),forceRender:true,children:<>
   <div className="lm-ops-grid"><Form.Item name={['spec','service_name']} label={t('服务标识','Service name')} rules={[{pattern:/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/,message:t('使用小写字母、数字和短横线，最长 63 字符','Use lowercase letters, numbers and hyphens, up to 63 characters')}]} extra={t('留空自动生成，创建后不可修改','Generated when blank; cannot be changed after creation')}><Input maxLength={63}/></Form.Item><Form.Item name={['spec','deployment_mode']} label={t('部署模式','Deployment mode')}><Select options={[{value:'manual',label:t('手动指定机器','Choose machines')},{value:'managed',label:t('自动调度','Automatic scheduling')}]}/></Form.Item></div>
   {mode==='managed'&&<Alert type={template.spec?.stateful?'warning':'info'} showIcon title={t('自动维护实例数量，故障时可更换机器','Maintains instance counts and can reschedule failures')} description={t('不会迁移本地数据或建立数据库复制。','Local data is not migrated and database replication is not configured.')}/>}
   <div className="lm-ops-grid">{(template.parameters??[]).filter(p=>!p.required&&p.key!=='port').map(parameter)}</div>
   {placements.map((_,index)=><div key={index}><h4>{placements.length>1?(clusters.find(c=>c.id===placements[index]?.cluster_id)?.name??t('安装位置','Installation target')):t('资源限制','Resource limits')}</h4><div className="lm-ops-grid"><Form.Item name={['spec','deployments',index,'cpu']} label={t('每实例 CPU 核数','CPU cores per instance')} rules={[{required:true}]}><InputNumber min={.01} max={1024}/></Form.Item><Form.Item name={['spec','deployments',index,'memory_mb']} label={t('每实例内存（MiB）','Memory per instance (MiB)')} rules={[{required:true}]}><InputNumber min={16} max={1048576}/></Form.Item></div>{gateway&&<Form.Item name={['spec','deployments',index,'gateway_dns_zone_id']} label={t('入口域名托管（可选）','Manage entry domain DNS (optional)')}><Select allowClear options={resources.filter(r=>r.kind==='dns_zone').map(r=>({value:r.id,label:r.name}))}/></Form.Item>}</div>)}
   <Button icon={<PlusOutlined/>} onClick={()=>form.setFieldValue(['spec','deployments'],[...(form.getFieldValue(['spec','deployments'])??[]),{machine_ids:[],replicas:1,cpu:template.id==='mysql'?1:.25,memory_mb:template.id==='mysql'?512:128}])}>{t('添加集群部署','Add cluster deployment')}</Button>
  </>}]} />
 </>;
}
