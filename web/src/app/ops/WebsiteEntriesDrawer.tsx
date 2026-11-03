import {useEffect,useRef,useState} from 'react';
import {Alert,App,Button,Drawer,Empty,Form,Select,Space} from '../../shared/ui';
import {api} from '../../shared/api';
import {useI18n} from '../../shared/i18n';
import {errorText,time,type Resource,type Spec} from './model';
import {entryDNS} from './website-state';
import {WebsiteStateTag} from './WebsiteOverview';

function EntryEditor({app,clusterID,resources,onSaved,onCancel}:{app:Resource;clusterID:string;resources:Resource[];onSaved:()=>Promise<void>;onCancel:()=>void}) {
 const {t}=useI18n(),{message}=App.useApp(),[form]=Form.useForm(),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const mounted=useRef(true),saving=useRef(false);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false}},[]);
 // Hold the revision/spec the user opened. Background observations must not reset input.
 const [snapshot]=useState(app),deployment=snapshot.spec.deployments.find((d:Spec)=>d.cluster_id===clusterID);
 const save=async(values:Spec)=>{if(saving.current)return;saving.current=true;setBusy(true);setError('');try{
  const deployments=snapshot.spec.deployments.map((d:Spec)=>d.cluster_id===clusterID?{...d,gateway_domain:undefined,gateway_dns_zone_id:values.zone,gateway_domain_generated:true}:d);
  await api('/ops/resources/'+encodeURIComponent(snapshot.id),{method:'PUT',body:JSON.stringify({revision:snapshot.revision,name:snapshot.name,spec:{...snapshot.spec,deployments}})});
  await onSaved();if(!mounted.current)return;void message.success(t('入口域名与解析方式已保存','Entry domain and DNS mode saved'));onCancel();
 }catch(e){if(!mounted.current)return;const code=errorText(e);setError(code==='platform_revision_conflict'?t('配置已被其他操作更新，当前输入已保留。请关闭编辑后重新打开最新配置。','Configuration changed elsewhere. Your input is preserved. Close the editor and reopen the latest configuration.'):code)}finally{saving.current=false;if(mounted.current)setBusy(false)}};
 return <Form form={form} layout="vertical" disabled={busy} initialValues={{zone:deployment.gateway_dns_zone_id??resources.find(r=>r.kind==='dns_zone')?.id}} onFinish={save} scrollToFirstError={{focus:true}} className="lm-entry-editor">
  {error&&<Alert type="error" showIcon title={t('未保存，输入已保留','Not saved; input preserved')} description={error}/>}
  <p className="lm-ops-note">{t('入口域名由系统生成，只需选择托管域名。','The entry domain is generated automatically. Select a hosted zone.')}</p>
  <Form.Item name="zone" label={t('托管域名','Hosted zone')} rules={[{required:true,message:t('请选择托管域名','Select a hosted zone')}]}><Select options={resources.filter(r=>r.kind==='dns_zone').map(r=>({value:r.id,label:r.name}))}/></Form.Item>
  <Space wrap><Button type="primary" aria-label={t('保存入口解析','Save entry DNS')} htmlType="submit" loading={busy}>{t('保存入口解析','Save entry DNS')}</Button><Button onClick={onCancel}>{t('取消','Cancel')}</Button></Space>
 </Form>;
}

export default function WebsiteEntriesDrawer({app,resources,open,onClose,onSaved,onAdvanced,onDetails,onMachine}:{app?:Resource;resources:Resource[];open:boolean;onClose:()=>void;onSaved:()=>Promise<void>;onAdvanced:()=>void;onDetails:()=>void;onMachine:(id:string)=>void}) {
 const {t}=useI18n(),[editing,setEditing]=useState<string>();
 return <Drawer open={open} title={t('OpenResty 管理','OpenResty management')} size={960} onClose={()=>{setEditing(undefined);onClose()}} className="lm-ops-entry-manager" destroyOnHidden>
  {app?<><div className="lm-ops-section-heading"><div><h3>{t('集群入口解析','Cluster entry DNS')}</h3><p className="lm-ops-note">{t('网站 CNAME → 集群入口域名 → 入口机器公网 IP。两个环节分别显示同步状态。','Website CNAME → cluster entry domain → entry host public IP. Each step has its own synchronization state.')}</p></div><Space wrap><Button onClick={onDetails}>{t('部署详情','Deployment details')}</Button><Button onClick={onAdvanced}>{t('调整 OpenResty 部署','Edit OpenResty deployments')}</Button></Space></div>
   {(app.spec.deployments??[]).map((d:Spec)=>{const state=entryDNS(app,d),missing:string[]=app.status.gateway_dns?.[d.cluster_id]?.missing_public_machine_ids??[];return <section className="lm-entry-row" key={d.cluster_id} aria-label={resources.find(r=>r.id===d.cluster_id)?.name??d.cluster_id}>
    <div className="lm-entry-row-heading"><h3>{resources.find(r=>r.id===d.cluster_id)?.name??d.cluster_id}</h3><WebsiteStateTag value={state}/></div>
    <strong className="lm-entry-domain">{d.gateway_domain||t('配置托管域名后自动生成','Generated after a hosted zone is configured')}</strong><p className="lm-website-hint">{t(...state.hint)}</p>
    {d.gateway_dns_zone_id&&<p className="lm-ops-note">{t('托管域名','Hosted domain')}：{resources.find(r=>r.id===d.gateway_dns_zone_id)?.name??d.gateway_dns_zone_id}{state.key==='verified'?' · '+time(app.status.dns_updated_at):''}</p>}
    {app.status.dns_error&&<details><summary>{t('错误详情','Error details')}</summary><code>{String(app.status.dns_error)}</code></details>}
    {missing.map(id=><Button key={id} type="link" onClick={()=>onMachine(id)}>{t('修正主机公网地址','Correct host public address')} · {id}</Button>)}
    {editing===d.cluster_id?<EntryEditor app={app} clusterID={d.cluster_id} resources={resources} onSaved={onSaved} onCancel={()=>setEditing(undefined)}/>:<Button disabled={!!editing} onClick={()=>setEditing(d.cluster_id)}>{t('编辑入口解析','Edit entry DNS')}</Button>}
   </section>})}
  </>:<Empty description={t('尚未配置网站入口','Website entry is not configured')}/>}
 </Drawer>;
}
