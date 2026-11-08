import {useEffect,useState} from 'react';
import {Link} from 'react-router-dom';
import {Alert,Button,Form,Select} from '../../shared/ui';
import {api} from '../../shared/api';
import {useI18n} from '../../shared/i18n';
import {errorText} from './model';

export default function RegistryCredentialSelect(){
  const {t}=useI18n(),[items,setItems]=useState<any[]>([]),[error,setError]=useState(''),[loading,setLoading]=useState(true);
  const load=async()=>{setLoading(true);try{setItems(await api<any[]>('/ops/registry-credentials'));setError('');}catch(e){setError(errorText(e));}finally{setLoading(false);}};
  useEffect(()=>{void load();},[]);
  return <>
    <Form.Item name={['spec','registry_credential_ids']} label={t('镜像仓库凭据','Registry credentials')} extra={<>{t('私有镜像选择对应仓库账号；公开镜像可留空。','Select accounts for private images; leave empty for public images.')} <Link target="_blank" to="/image-sources">{t('管理仓库凭据','Manage registry credentials')}</Link> <Button type="link" size="small" onClick={()=>void load()}>{t('刷新凭据','Refresh credentials')}</Button></>}>
      <Select aria-label={t('镜像仓库凭据','Registry credentials')} mode="multiple" style={{width:'100%'}} popupMatchSelectWidth={280} styles={{popup:{root:{maxWidth:'calc(100vw - 32px)'}}}} allowClear loading={loading} optionFilterProp="label" placeholder={t('选择仓库凭据（可选）','Select registry credentials (optional)')} options={items.map(c=>({value:c.id,label:c.name+' · '+c.registry+' · '+c.username+(c.status==='active'?'':' · '+t('不可用','Unavailable')),disabled:c.status!=='active'}))}/>
    </Form.Item>
    {error&&<Alert type="error" showIcon title={t('仓库凭据加载失败','Could not load registry credentials')} description={error}/>}
  </>;
}
