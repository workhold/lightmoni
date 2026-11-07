import {Alert,Tag,Tooltip} from '../shared/ui';
import {useI18n} from '../shared/i18n';
import {time,type Spec} from './ops/model';
export default function TelemetryCollectionStatus({hosts}:{hosts:Spec[]}){
 const {t}=useI18n();
 if(!hosts.length)return null;
 return <div className="lm-collection-status" aria-label={t('默认采集状态','Default collection status')}>{hosts.map(h=>{
  const s=h.application_observation,center=h.center_observation,last=s?.last_success_at;
  if(center?.error||s?.state==='degraded')return <Alert key={h.id} showIcon type="warning" title={h.name+' · '+t('采集异常','Collection degraded')} description={<><div>{center?.error||s?.error}</div><small>{t('最近尝试','Last attempt')} {time(s?.attempted_at)}{last&&<> · {t('最近成功','Last success')} {time(last)}</>} · {t('待发送批次','Queued batches')} {s?.queue_batches??0} / {center?.pending_batches??0}</small></>}/>;
  return <div key={h.id} className="lm-collection-host"><strong>{h.name}</strong><Tag color={s?.state==='ok'?'success':undefined}>{s?.state==='ok'?t('采集正常','Collection active'):t('等待采集诊断','Waiting for diagnostics')}</Tag>{last&&<Tooltip title={t('最近成功','Last success')+' · '+time(last)}><time dateTime={last}>{time(last)}</time></Tooltip>}</div>;
 })}</div>;
}
