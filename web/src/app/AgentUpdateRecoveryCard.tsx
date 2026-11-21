import {type ReactNode} from 'react';
import {Button,Checkbox,Tag} from '../shared/ui';
import {useI18n} from '../shared/i18n';
import {installedRelease,shortIdentity,updateStatusText,type AgentUpdate} from './agent-update-model';

type Props={
 record:AgentUpdate;
 latest?:{at:string;stage:string};
 stageText:(stage:string)=>string;
 credentialSelect:ReactNode;
 accountHelp:ReactNode;
 recoveryReviewed:boolean;
 recoveryLocked:boolean;
 refreshNeeded:boolean;
 changing:boolean;
 busy:string;
 recoveryRevisionReady:boolean;
 onReconcile:()=>void;
 onRecover:()=>void;
 onConfirmRecovery:(checked:boolean)=>void;
};

export default function AgentUpdateRecoveryCard({record,latest,stageText,credentialSelect,accountHelp,recoveryReviewed,recoveryLocked,refreshNeeded,changing,busy,recoveryRevisionReady,onReconcile,onRecover,onConfirmRecovery}:Props){
 const {t,language}=useI18n(),plan=record.plan,current=installedRelease(plan?.current);
 const recoveryDisabled=changing||!recoveryReviewed||refreshNeeded||recoveryLocked;
 const guidance=recoveryLocked
  ?t('上次恢复未确认；请先核对，不能重复提交。','The last recovery was not confirmed. Verify it first; do not submit recovery again.')
  :t('先核对远端事实；恢复入口只在核对后开放。','Verify the remote facts first. Recovery opens only after verification.');
 return <section className="lm-agent-recovery-card" aria-label={t('Agent 维护结果核对与恢复','Agent maintenance verification and recovery')}>
  <header className="lm-agent-recovery-head">
   <div className="lm-agent-recovery-title">
    <Tag color="warning">{updateStatusText(record.status,t)}</Tag>
    <strong>{t('先核对，再恢复','Verify first, then recover')}</strong>
   </div>
   <span>{guidance}</span>
  </header>

  <dl className="lm-agent-recovery-facts">
   <div><dt>{t('主机','Host')}</dt><dd>{plan?.machine?.name||record.machine_id}</dd></div>
   <div><dt>{t('当前','Current')}</dt><dd>{current?.version||t('未知','Unknown')} · {shortIdentity(current?.source_revision)}</dd></div>
   <div><dt>{t('目标','Target')}</dt><dd>{plan?.target?.version||'—'} · {shortIdentity(plan?.target?.source_revision)}</dd></div>
   <div><dt>{latest?t('最后阶段','Last stage'):t('阶段','Stage')}</dt><dd>{latest?stageText(latest.stage):t('待读取','Not read yet')}</dd></div>
  </dl>
  {latest&&<time dateTime={latest.at}>{new Date(latest.at).toLocaleString(language)}</time>}

  <div className="lm-agent-recovery-credential">
   <span>{t('SSH 凭据','SSH credential')}</span>
   {credentialSelect}
   {accountHelp}
  </div>

  <div className="lm-agent-recovery-actions">
   <Button type="primary" loading={busy==='reconcile'} disabled={changing} onClick={onReconcile}>{t('1 · 只读核对','1 · Verify')}</Button>
   <Button danger loading={busy==='recover'} disabled={recoveryDisabled} onClick={onRecover}>{t('2 · 审阅后恢复','2 · Reviewed recovery')}</Button>
  </div>

  <div className="lm-agent-recovery-confirm">
   <Checkbox checked={recoveryReviewed} disabled={changing||!recoveryRevisionReady||refreshNeeded||recoveryLocked} onChange={event=>onConfirmRecovery(event.target.checked)}>
    {t('我已核对主机、当前/目标发行和恢复影响','I verified the host, current/target releases, and recovery impact')}
   </Checkbox>
   {!recoveryRevisionReady&&<small>{t('请先核对，读取当前恢复条件。','Verify first to read current recovery conditions.')}</small>}
  </div>

  {recoveryLocked&&<div className="lm-agent-recovery-warning" role="alert"><strong>{t('上次恢复结果未知','Last recovery outcome is unknown')}</strong><span>{t('恢复已锁定；核对通过后自动解锁。','Recovery is locked. It unlocks after verification passes.')}</span></div>}

  <details className="lm-agent-update-technical">
   <summary>{t('恢复影响','Recovery impact')}</summary>
   <ul>
    <li>{t('恢复前核验原事务、维护进程和原程序指纹。','Before recovery, the original transaction, maintenance process, and previous runtime fingerprint are verified.')}</li>
    <li>{t('未切换则结束本次维护；已切换则只恢复审批固定的原程序。','If not switched, this maintenance ends as failed. If switched, only the approved previous runtime is restored.')}</li>
    <li>{t('证据不一致保持未知；不重放升级，也不重新接入。','Inconsistent evidence stays unknown. The upgrade is not replayed and Agent is not re-enrolled.')}</li>
   </ul>
   <dl className="lm-agent-recovery-ids">
    <div><dt>{t('操作 ID','Operation ID')}</dt><dd><code>{record.id}</code></dd></div>
    <div><dt>{t('恢复版本','Recovery revision')}</dt><dd><code>{record.recovery_revision?shortIdentity(record.recovery_revision,16):'—'}</code></dd></div>
   </dl>
  </details>
 </section>;
}
