import {useEffect,useRef,useState} from 'react';
import {Alert,App,Button,Drawer,Empty,Form,Input,Select,Space} from '../../shared/ui';
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
  const domain=values.domain.trim().toLowerCase(),deployments=snapshot.spec.deployments.map((d:Spec)=>d.cluster_id===clusterID?{...d,gateway_domain:domain,gateway_dns_zone_id:values.mode==='managed'?values.zone:undefined}:d);
  await api('/ops/resources/'+encodeURIComponent(snapshot.id),{method:'PUT',body:JSON.stringify({revision:snapshot.revision,name:snapshot.name,spec:{...snapshot.spec,deployments}})});
  await onSaved();if(!mounted.current)return;void message.success(t('入口域名与解析方式已保存','Entry domain and DNS mode saved'));onCancel();
 }catch(e){if(!mounted.current)return;const code=errorText(e),domainErrors=['invalid_domain','gateway_domain_outside_dns_scope','duplicate_gateway_domain','gateway_domain_conflicts_with_website'];if(domainErrors.includes(code)){form.setFields([{name:'domain',errors:[code==='gateway_domain_outside_dns_scope'?t('入口域名必须属于所选托管域名。','The entry domain must belong to the selected hosted domain.'):t('入口域名无效或已被占用，请核对。','The entry domain is invalid or already in use. Please check it.')]}]);form.scrollToField('domain',{focus:true})}else setError(code==='platform_revision_conflict'?t('配置已被其他操作更新，当前输入已保留。请关闭编辑后重新打开最新配置。','Configuration changed elsewhere. Your input is preserved. Close the editor and reopen the latest configuration.'):code)}finally{saving.current=false;if(mounted.current)setBusy(false)}};
 return <Form form={form} layout="vertical" disabled={busy} initialValues={{domain:deployment.gateway_domain??'',mode:deployment.gateway_dns_zone_id?'managed':'external',zone:deployment.gateway_dns_zone_id}} onFinish={save} scrollToFirstError={{focus:true}} className="lm-entry-editor">
  {error&&<Alert type="error" showIcon title={t('未保存，输入已保留','Not saved; input preserved')} description={error}/>}
  <Form.Item name="domain" label={t('集群入口域名','Cluster entry domain')} rules={[{required:true,message:t('请填写入口域名','Enter an entry domain')},{validator:(_,value)=>!value||/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(value.trim())?Promise.resolve():Promise.reject(Error(t('请填写完整域名，不含协议、端口或路径。','Enter a domain without a scheme, port or path.')))}]}><Input autoComplete="off" placeholder="edge.example.com"/></Form.Item>
  <Form.Item name="mode" label={t('入口 A / AAAA 解析','Entry A / AAAA DNS')}><Select options={[{value:'managed',label:t('由系统自动维护','Maintain automatically')},{value:'external',label:t('自行维护解析','Maintain externally')}]}/></Form.Item>
  <Form.Item noStyle shouldUpdate={(a,b)=>a.mode!==b.mode}>{({getFieldValue})=>getFieldValue('mode')==='managed'?<Form.Item name="zone" label={t('托管域名','Hosted domain')} rules={[{required:true,message:t('请选择托管域名','Select a hosted domain')},{validator:(_,value)=>{const zone=resources.find(r=>r.id===value),domain=String(form.getFieldValue('domain')??'').trim().toLowerCase(),parent=zone?.spec.scope??zone?.spec.domain;return !parent||domain===parent||domain.endsWith('.'+parent)?Promise.resolve():Promise.reject(Error(t('入口域名必须属于此托管域名。','The entry domain must belong to this hosted domain.')))}}]} dependencies={['domain']}><Select options={resources.filter(r=>r.kind==='dns_zone').map(r=>({value:r.id,label:r.name}))}/></Form.Item>:<p className="lm-ops-note">{t('系统不会创建此入口的地址记录。请将入口域名解析到入口机器的公网服务地址。','The system will not create entry address records. Point the domain to the entry hosts’ public service addresses.')}</p>}</Form.Item>
  <Space wrap><Button type="primary" aria-label={t('保存入口解析','Save entry DNS')} htmlType="submit" loading={busy}>{t('保存入口解析','Save entry DNS')}</Button><Button onClick={onCancel}>{t('取消','Cancel')}</Button></Space>
 </Form>;
}

export default function WebsiteEntriesDrawer({app,resources,open,onClose,onSaved,onAdvanced,onDetails,onMachine}:{app?:Resource;resources:Resource[];open:boolean;onClose:()=>void;onSaved:()=>Promise<void>;onAdvanced:()=>void;onDetails:()=>void;onMachine:(id:string)=>void}) {
 const {t}=useI18n(),[editing,setEditing]=useState<string>();
 return <Drawer open={open} title={t('OpenResty 管理','OpenResty management')} size={960} onClose={()=>{setEditing(undefined);onClose()}} className="lm-ops-entry-manager" destroyOnHidden>
  {app?<><div className="lm-ops-section-heading"><div><h3>{t('集群入口解析','Cluster entry DNS')}</h3><p className="lm-ops-note">{t('网站 CNAME → 集群入口域名 → 入口机器公网 IP。两个环节分别显示同步状态。','Website CNAME → cluster entry domain → entry host public IP. Each step has its own synchronization state.')}</p></div><Space wrap><Button onClick={onDetails}>{t('部署详情','Deployment details')}</Button><Button onClick={onAdvanced}>{t('调整 OpenResty 部署','Edit OpenResty deployments')}</Button></Space></div>
   {(app.spec.deployments??[]).map((d:Spec)=>{const state=entryDNS(app,d),missing:string[]=app.status.gateway_dns?.[d.cluster_id]?.missing_public_machine_ids??[];return <section className="lm-entry-row" key={d.cluster_id} aria-label={resources.find(r=>r.id===d.cluster_id)?.name??d.cluster_id}>
    <div className="lm-entry-row-heading"><h3>{resources.find(r=>r.id===d.cluster_id)?.name??d.cluster_id}</h3><WebsiteStateTag value={state}/></div>
    <strong className="lm-entry-domain">{d.gateway_domain||t('尚未设置域名','Domain not configured')}</strong><p className="lm-website-hint">{t(...state.hint)}</p>
    {d.gateway_dns_zone_id&&<p className="lm-ops-note">{t('托管域名','Hosted domain')}：{resources.find(r=>r.id===d.gateway_dns_zone_id)?.name??d.gateway_dns_zone_id}{state.key==='verified'?' · '+time(app.status.dns_updated_at):''}</p>}
    {app.status.dns_error&&<details><summary>{t('错误详情','Error details')}</summary><code>{String(app.status.dns_error)}</code></details>}
    {missing.map(id=><Button key={id} type="link" onClick={()=>onMachine(id)}>{t('修正主机公网地址','Correct host public address')} · {id}</Button>)}
    {editing===d.cluster_id?<EntryEditor app={app} clusterID={d.cluster_id} resources={resources} onSaved={onSaved} onCancel={()=>setEditing(undefined)}/>:<Button disabled={!!editing} onClick={()=>setEditing(d.cluster_id)}>{t('编辑入口解析','Edit entry DNS')}</Button>}
   </section>})}
  </>:<Empty description={t('尚未配置网站入口','Website entry is not configured')}/>}
 </Drawer>;
}
