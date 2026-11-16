import {Tabs} from '../shared/ui';
import {useI18n} from '../shared/i18n';
import {useSearchParams} from 'react-router-dom';
import PrivateRegistryPage from './PrivateRegistryPage';
import ImageSourcesPage from './ImageSourcesPage';
import {normalizeImageManagementTab} from './image-management';
import './operations.css';

export default function ImageManagementPage() {
 const {t}=useI18n(),[searchParams,setSearchParams]=useSearchParams(),tab=normalizeImageManagementTab(searchParams.get('tab'));
 return <div className="lm-page lm-operations-page lm-image-management-page">
  <Tabs activeKey={tab} onChange={value=>setSearchParams(previous=>{const next=new URLSearchParams(previous);next.set('tab',value);return next})} items={[
   {key:'images',label:t('镜像与版本','Images & versions')},
   {key:'registry',label:t('仓库与发布入口','Registry & publishing')},
   {key:'sources',label:t('凭据与来源代理','Credentials & source proxies')},
  ]}/>
  {tab==='images'&&<PrivateRegistryPage view='images'/>}
  {tab==='registry'&&<PrivateRegistryPage view='registry'/>}
  {tab==='sources'&&<ImageSourcesPage embedded/>}
 </div>;
}
