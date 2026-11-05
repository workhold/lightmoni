import {useEffect,useRef,useState} from 'react';
import {Alert,Button,Descriptions,Form,Input,Modal,Space,Spin,Typography} from '../../shared/ui';
import {api} from '../../shared/api';
import {useI18n} from '../../shared/i18n';
import {errorText,type Resource,type Spec} from './model';

const messages:Record<string,[string,string]>={
 platform_revision_conflict:['应用配置已变化，请重新检查后升级。','The application changed. Check again before upgrading.'],
 application_template_changed:['商店版本已变化，请重新检查。','The store version changed. Check again.'],
 upgrade_service_topology_changed:['新模板的服务结构已变化，请在配置中手动迁移。','The template service layout changed. Migrate it in configuration.'],
 application_template_not_found:['商店已移除此模板，请使用应用配置手动更新。','This template was removed from the store. Update the application configuration.'],
 platform_resource_busy:['应用有进行中或结果未知的执行，请先查看安装记录并核对。','An execution is active or unknown. Review installation history first.'],
 image_refresh_agent_upgrade_required:['请先升级部署主机的 Agent，当前执行器不支持强制刷新镜像。','Upgrade the deployment host Agent first. Its executor does not support refreshing images.'],
 invalid_upgrade_image:['镜像格式不正确，请填写镜像名称、标签或摘要。','Enter a valid image name, tag, or digest.'],
};
export default function ApplicationUpgradeDialog({resource,onClose,onSubmitted}:{resource:Resource;onClose:()=>void;onSubmitted:(resource:Resource,warning?:string)=>Promise<void>}){
 const {t}=useI18n(),[preview,setPreview]=useState<Spec>(),[images,setImages]=useState<Record<string,string>>({}),[error,setError]=useState(''),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),lock=useRef(false);
 const explain=(code:string)=>messages[code]?t(...messages[code]):code;
 const load=async()=>{setLoading(true);setError('');setPreview(undefined);try{const result=await api<Spec>(`/ops/resources/${encodeURIComponent(resource.id)}/upgrade`);setPreview(result);setImages(result.target_images)}catch(e){setError(explain(errorText(e)))}finally{setLoading(false)}};
 useEffect(()=>{void load()},[resource.id]);
 const submit=async()=>{
  if(!preview||preview.blocked_reason||lock.current)return;lock.current=true;setBusy(true);setError('');
  try{const result=await api<{resource:Resource;deploy_error?:string;deployments?:Spec[]}>(`/ops/resources/${encodeURIComponent(resource.id)}/upgrade`,{method:'POST',body:JSON.stringify({revision:preview.revision,confirmed:true,...(preview.source==='store'?{target_version:preview.target_version,target_fingerprint:preview.target_fingerprint}:{images})})});await onSubmitted(result.resource,result.deploy_error||result.deployments?.some(d=>d.error)?t('升级配置已保存，部分部署未提交，请查看安装记录后重试部署。','Upgrade configuration saved. Some deployments were not submitted. Review history and retry deployment.'):undefined);}
  catch(e){setError(explain(errorText(e)))}finally{setBusy(false);lock.current=false}
 };
 return <Modal open title={t('升级应用','Upgrade application')+' · '+resource.name} onCancel={()=>{if(!busy)onClose()}} maskClosable={false} closable={!busy} footer={<Space><Button disabled={busy} onClick={()=>void load()}>{t('重新检查','Check again')}</Button><Button disabled={busy} onClick={onClose}>{t('取消','Cancel')}</Button><Button type="primary" loading={busy} disabled={loading||!preview||!!preview.blocked_reason||Object.values(images).some(v=>!v.trim())} onClick={()=>void submit()}>{t('确认升级','Confirm upgrade')}</Button></Space>}>
  <Spin spinning={loading}>{preview&&<><Descriptions column={1} size="small" items={[{key:'revision',label:t('配置修订','Configuration revision'),children:'v'+preview.revision},...(preview.source==='store'?[{key:'version',label:t('商店版本','Store version'),children:(preview.current_version||'—')+' → '+preview.target_version}]:[])]}/>
   <Form layout="vertical">{Object.entries<string>(preview.current_images).map(([service,current])=><Form.Item key={service} label={service+' · '+t('目标镜像','Target image')}><Typography.Paragraph type="secondary">{t('当前','Current')+': '+current}</Typography.Paragraph>{preview.source==='store'?<Typography.Text code>{preview.target_images[service]}</Typography.Text>:<Input aria-label={t('目标镜像','Target image')+' · '+service} value={images[service]} disabled={busy} maxLength={512} onChange={e=>setImages(v=>({...v,[service]:e.target.value}))}/>}</Form.Item>)}</Form>
   {preview.blocked_reason&&<Alert showIcon type="warning" title={explain(preview.blocked_reason)}/>}
   <Alert showIcon type="warning" title={t('确认后自动拉取镜像并更新全部部署','Pull images and update all deployments after confirmation')} description={t('保留环境变量、密码、数据挂载、端口和部署位置。相同标签也会重新拉取，后续部署始终刷新镜像。更新可能短暂中断服务；数据库版本兼容与备份需事先确认。结果以安装记录为准。','Environment variables, passwords, data mounts, ports, and placements are retained. The same tag is pulled again; future deployments refresh images. Updates may briefly interrupt service. Check database compatibility and backups first. Review installation history for results.')}/>
  </>}{error&&<Alert showIcon type="error" title={error}/>}</Spin>
 </Modal>;
}
