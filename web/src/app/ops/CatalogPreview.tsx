import CodeEditor from '../../shared/CodeEditor';
import {useEffect,useRef,useState} from 'react';
import {Alert,Button,Form,Typography} from '../../shared/ui';
import {api} from '../../shared/api';
import {useI18n} from '../../shared/i18n';
import type {CatalogTemplate,Spec} from './model';

export default function CatalogPreview({template}:{template:CatalogTemplate}){
 const {t}=useI18n(),form=Form.useFormInstance(),values=Form.useWatch([],form),[open,setOpen]=useState(false),[yaml,setYAML]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false),sequence=useRef(0);
 useEffect(()=>{if(!open)return;const serial=++sequence.current,abort=new AbortController();setBusy(true);setError('');setYAML('');const timer=setTimeout(()=>{const v=form.getFieldsValue(true) as Spec;void api<{yaml:string}>('/ops/catalog/'+encodeURIComponent(template.id)+'/preview',{method:'POST',signal:abort.signal,body:JSON.stringify({version:v.version,parameters:v.parameters??{},host_ports:v.host_ports,listen_ip:template.id==='openresty'?undefined:v.listen_ip,deployment_mode:v.spec?.deployment_mode,deployments:v.automatic_placement===false?v.spec?.deployments:undefined})}).then(r=>{if(serial===sequence.current&&!abort.signal.aborted)setYAML(r.yaml)}).catch(e=>{if(serial===sequence.current&&!abort.signal.aborted)setError(e instanceof Error?e.message:String(e))}).finally(()=>{if(serial===sequence.current&&!abort.signal.aborted)setBusy(false)})},300);return()=>{clearTimeout(timer);abort.abort();sequence.current++}},[open,JSON.stringify(values),template.id]);
 return <section className="lm-catalog-preview"><Button onClick={()=>setOpen(v=>!v)}>{open?t('收起安装配置','Hide installation configuration'):t('安装前查看 YAML','Preview installation YAML')}</Button>{open&&<><Typography.Paragraph type="secondary">{t('预览随表单更新，秘密已隐藏。数据目录、项目卷名及自动端口在部署时分配；不执行安装。','Updates with the form; secrets are hidden. Data paths, project volume names and automatic ports are assigned at deployment. Preview does not install.')}</Typography.Paragraph>{busy&&<Typography.Paragraph>{t('正在生成预览…','Preparing preview…')}</Typography.Paragraph>}{error&&<Alert type="warning" showIcon title={t('请完善参数后查看配置','Complete the parameters to preview configuration')} description={error}/>}<CodeEditor language="yaml" readOnly ariaLabel={t('安装配置预览','Installation configuration preview')} height={360} value={yaml}/></>}</section>;
}
