import type {Spec} from './model';

export function recoveryMessage(value?:Spec):[string,string]|undefined {
 if(!value||value.state==='in_sync')return;
 if(value.state==='blocked') {
  if((value.code??value.error??'').toLowerCase()==='legacy_website_evidence_required')return ['历史网关证据不足，已暂停清理','Historical gateway evidence is incomplete; cleanup paused'];
  if(/ownership|unowned|unsafe|layout_mismatch/.test(value.code??value.error??''))return ['目录归属需要核对，已暂停自动变更','Directory ownership needs verification; automatic changes paused'];
  if((value.code??value.error)==='unknown_execution_result')return ['等待核对未知执行结果','Waiting for unknown execution verification'];
  if((value.code??value.error)==='deployment_recovery_exhausted')return ['自动恢复连续失败，请检查安装记录','Automatic recovery failed repeatedly; check installation history'];
  return ['自动恢复受阻，请检查主机与授权','Automatic recovery blocked; check the host and authorization'];
 }
 const code=value.code??'';
 if(code==='machine_busy'||code==='deployment_busy')return ['等待主机任务完成后自动核对','Will verify automatically after the host task completes'];
 if(code==='agent_offline')return ['等待主机上线后自动恢复','Will recover automatically when the host reconnects'];
 if(code==='verifying_deployment')return ['正在自动核对运行状态','Automatically verifying runtime state'];
 if(code==='deployment_drift_repair'||code==='managed_deployment_recovery')return ['正在按已发布配置自动恢复','Automatically restoring the published configuration'];
 if(value.state==='drifted')return ['恢复失败，稍后自动重试','Recovery failed; will retry automatically'];
}

export function deletionMessage(value:Spec):[string,string] {
 if(value.state==='blocked')return recoveryMessage({...value,code:value.error})!;
 if(String(value.error??'').includes('unknown'))return ['等待核对历史执行结果','Waiting for historical execution verification'];
 if(value.state==='unknown')return ['清理结果未知，等待核对','Cleanup result unknown; waiting for verification'];
 if(value.state==='failed')return ['清理失败，等待自动重试','Cleanup failed; waiting for automatic retry'];
 return ['正在撤流并清理各主机数据','Withdrawing traffic and cleaning host data'];
}
