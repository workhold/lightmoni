import {Alert,Tag} from '../shared/ui';
import {useI18n} from '../shared/i18n';
import {time,type Spec} from './ops/model';
export default function TelemetryCollectionStatus({hosts}:{hosts:Spec[]}){
 const {t}=useI18n();
 return <div aria-label={t('默认采集状态','Default collection status')}>{hosts.map(h=>{
  const s=h.application_observation,center=h.center_observation;
  if(center?.error||s?.state==='degraded')return <Alert key={h.id} showIcon type="warning" title={h.name+' · '+t('容器采集或上报异常','Container collection or reporting failed')} description={<>{center?.error||s?.error} · {t('最近尝试','Last attempt')} {time(s?.attempted_at)} · {t('待发送批次','Queued batches')} {s?.queue_batches??0} / {center?.pending_batches??0}</>}/>;
  return <p key={h.id} className="lm-ops-note">{h.name} · <Tag color={s?.state==='ok'?'green':undefined}>{s?.state==='ok'?t('默认采集正常','Default collection active'):t('采集诊断待上报','Waiting for collection diagnostics')}</Tag>{s?.last_success_at&&<>{t('最近成功','Last success')} {time(s.last_success_at)}</>}</p>;
 })}</div>;
}
