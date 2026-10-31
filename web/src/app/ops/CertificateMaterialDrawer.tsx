import {useEffect,useRef,useState} from 'react';
import {DownloadOutlined,ReloadOutlined} from '@ant-design/icons';
import {Alert,Button,Descriptions,Drawer,Empty,Input,Space,Spin,Tabs,Typography} from '../../shared/ui';
import {api} from '../../shared/api';
import {useI18n} from '../../shared/i18n';
import {errorText,time,type Resource} from './model';

interface CertificateView {
 certificate_version:string;domains:string[];not_before:string;expires_at:string;
 fingerprint_sha256:string;subject:string;issuer:string;chain_length:number;
 certificate_pem:string;chain_pem:string;fullchain_pem:string;
}
type Format='cert'|'chain'|'fullchain'|'private_key';
export default function CertificateMaterialDrawer({resource,onClose}:{resource?:Resource;onClose:()=>void}){
 const {t}=useI18n(),[data,setData]=useState<CertificateView>(),[loading,setLoading]=useState(false),[error,setError]=useState(''),[downloadError,setDownloadError]=useState(''),[downloading,setDownloading]=useState<Format>(),[retry,setRetry]=useState(0),downloadRequest=useRef<AbortController|undefined>(undefined);
 useEffect(()=>{
  setData(undefined);setError('');setDownloadError('');setDownloading(undefined);
  downloadRequest.current?.abort();
  if(!resource){setLoading(false);return;}
  const controller=new AbortController();setLoading(true);
  void api<{certificate:CertificateView}>('/ops/resources/'+encodeURIComponent(resource.id)+'/certificate',{signal:controller.signal,cache:'no-store'}).then(result=>{if(!controller.signal.aborted)setData(result.certificate)}).catch(e=>{if(!controller.signal.aborted)setError(errorText(e))}).finally(()=>{if(!controller.signal.aborted)setLoading(false)});
  return()=>{controller.abort();downloadRequest.current?.abort()};
 },[resource?.id,retry]);
 const download=async(format:Format)=>{
  if(!resource||!data||downloadRequest.current&&!downloadRequest.current.signal.aborted)return;
  const controller=new AbortController();downloadRequest.current=controller;setDownloading(format);setDownloadError('');
  try{
   const response=await fetch('/api/v1/ops/resources/'+encodeURIComponent(resource.id)+'/certificate/download',{method:'POST',credentials:'include',cache:'no-store',signal:controller.signal,headers:{'Content-Type':'application/json'},body:JSON.stringify({version:data.certificate_version,format})});
   if(!response.ok){const body=await response.json().catch(()=>({}));throw Error(body.error??'HTTP '+response.status);}
   const blob=await response.blob();if(controller.signal.aborted)return;
   const url=URL.createObjectURL(blob),anchor=document.createElement('a');
   anchor.href=url;anchor.download=resource.id+'-'+data.certificate_version+'-'+({cert:'cert.pem',chain:'chain.pem',fullchain:'fullchain.pem',private_key:'privkey.pem'}[format]);
   document.body.appendChild(anchor);anchor.click();anchor.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }catch(e){if(!controller.signal.aborted)setDownloadError(errorText(e))}finally{if(downloadRequest.current===controller){downloadRequest.current=undefined;setDownloading(undefined)}}
 };
 const downloadButton=(format:Format,label:string,primary=false)=><Button type={primary?'primary':'default'} icon={<DownloadOutlined aria-hidden/>} loading={downloading===format} disabled={!!downloading||(format==='chain'&&!data?.chain_pem)} onClick={()=>void download(format)}>{label}</Button>;
 const pem=(value:string,label:string)=><Input.TextArea aria-label={label} readOnly value={value} autoSize={{minRows:8,maxRows:15}} spellCheck={false} className="lm-ops-certificate-pem"/>;
 return <Drawer open={!!resource} title={t('查看 / 下载证书','View / download certificate')+' · '+(resource?.name??'')} size="min(820px, 100vw)" styles={{wrapper:{maxWidth:'100vw'}}} onClose={onClose} destroyOnHidden>
  <Spin spinning={loading}>
   {error&&<Alert type="error" showIcon title={t('证书加载失败','Could not load certificate')} description={error} action={<Button icon={<ReloadOutlined aria-hidden/>} onClick={()=>setRetry(n=>n+1)}>{t('重试','Retry')}</Button>}/>}
   {data&&<>
    {Date.parse(data.expires_at)<=Date.now()&&<Alert type="warning" showIcon title={t('此证书已过期','This certificate has expired')}/>}
    <Descriptions size="small" column={{xs:1,sm:2}} className="lm-ops-certificate-metadata" items={[
     {key:'domains',label:t('域名','Domains'),span:'filled',children:data.domains.join(' · ')},
     {key:'subject',label:t('主体','Subject'),children:data.subject},{key:'issuer',label:t('签发者','Issuer'),children:data.issuer},
     {key:'start',label:t('生效时间','Valid from'),children:time(data.not_before)},{key:'end',label:t('到期时间','Expires'),children:time(data.expires_at)},
     {key:'version',label:t('证书版本','Certificate version'),span:'filled',children:<Typography.Text copyable>{data.certificate_version}</Typography.Text>},
     {key:'fingerprint',label:t('SHA-256 指纹','SHA-256 fingerprint'),span:'filled',children:<Typography.Text copyable>{data.fingerprint_sha256}</Typography.Text>},
    ]}/>
    <Space wrap className="lm-ops-certificate-downloads">
     {downloadButton('fullchain',t('下载完整证书链','Download full chain'),true)}
     {downloadButton('cert',t('下载证书 PEM','Download certificate PEM'))}
     {downloadButton('chain',t('下载证书链','Download chain'))}
     {downloadButton('private_key',t('下载私钥','Download private key'))}
    </Space>
    {downloadError&&<Alert type="error" showIcon title={t('下载失败，请重试','Download failed; try again')} description={downloadError}/>}
    <Tabs defaultActiveKey="cert" items={[
     {key:'cert',label:t('证书 PEM','Certificate PEM'),children:pem(data.certificate_pem,t('证书 PEM','Certificate PEM'))},
     {key:'chain',label:t('证书链','Certificate chain')+' · '+Math.max(0,data.chain_length-1),children:data.chain_pem?pem(data.chain_pem,t('证书链 PEM','Chain PEM')):<Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('此版本未包含中间证书链','This version contains no intermediate chain')}/>},
     {key:'fullchain',label:t('完整证书链','Full chain'),children:pem(data.fullchain_pem,t('完整证书链 PEM','Full chain PEM'))},
    ]}/>
   </>}
  </Spin>
 </Drawer>;
}
