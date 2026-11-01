/** Only explicitly migrated host profiles may dispatch work to a privileged executor. */
export const HOST_PROFILE_UNAVAILABLE:[string,string]=['此功能尚未接入独立运维执行器，暂不可执行；没有下发任务。','This feature is not connected to the independent privileged executor yet. No task was dispatched.'];
export const LEGACY_CHANNEL_REMOVED:[string,string]=['旧 Agent 运维通道已移除。请使用主机的独立运维执行器；升级普通 Agent 不会启用此通道。','The legacy Agent operations channel was removed. Use the host’s independent privileged executor; upgrading the normal Agent does not enable this channel.'];
export function hostActionUnavailable(resource:{kind:string;spec?:{type?:string}},action:string):boolean{
 switch(resource.kind){
  case 'cluster':case 'node_pool':return action==='inspect';
  case 'application':return ['deploy','inspect','stop','remove','logs','reconcile'].includes(action);
  case 'website':return ['deploy','disable'].includes(action);
  case 'service':return ['deploy','reconcile','inspect','stop'].includes(action);
  case 'gateway_group':return ['deploy','inspect','stop'].includes(action);
  case 'certificate_target':return resource.spec?.type!=='cloud'&&['sync','inspect','retry'].includes(action);
  default:return false;
 }
}
export function hostExecutionDiagnostic(code:string):[string,string]|undefined{
 if(['privileged_executor_required','privileged_profile_not_implemented'].includes(code))return HOST_PROFILE_UNAVAILABLE;
 if(['legacy_agent_payload_removed','legacy_docker_channel_removed'].includes(code))return LEGACY_CHANNEL_REMOVED;
}
