import {Tag} from '../shared/ui';
import {useI18n} from '../shared/i18n';
import type {HostNetwork} from './HostNetworkSummary';
import './host-network-overview.css';

/** The host list uses configured service addresses, never inferred ingress. */
export default function HostNetworkOverview({network}:{network?:HostNetwork}){
 const {t}=useI18n();
 const settings=network?.service_addresses;
 const scopes=['private','public'] as const;
 const hasAddress=scopes.some(scope=>!!settings?.[scope]?.effective);
 const needsConfirmation=scopes.some(scope=>settings?.[scope]?.needs_confirmation);

 if(!settings||!hasAddress&&!needsConfirmation)return <div className="lm-host-network-overview" role="group" aria-label={t('服务地址','Service addresses')}>
  <span>{settings?t('服务地址未配置','Service addresses not configured'):t('服务地址待发现','Service addresses not discovered')}</span>
 </div>;

 return <div className="lm-host-network-overview" role="group" aria-label={t('服务地址','Service addresses')}>
  {scopes.map(scope=>{
   const choice=settings[scope];
   const label=scope==='private'?t('内网','Private'):t('公网','Public');
   return <span key={scope} className="lm-host-network-overview-entry">
    <span className="lm-host-network-overview-label">{label}</span>
    <span className="lm-host-network-overview-address">{choice?.effective||t('未配置','Not configured')}</span>
    {choice?.needs_confirmation&&<Tag color="warning">{t('待确认','Confirm address')}</Tag>}
   </span>;
  })}
 </div>;
}
