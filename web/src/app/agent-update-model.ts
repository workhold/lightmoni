export interface AgentRelease {
 version:string;source_revision:string;build_id:string;state_schema:number;
 platform:string;arch:string;file?:string;sha256:string;size?:number;build_time?:string;
}
export interface AgentInstalledRelease {
 version?:string;source_revision?:string;build_id?:string;state_schema?:number;
 artifact_sha256?:string;boot_id?:string;arch?:string;
}
export interface AgentUpdateCurrent extends AgentInstalledRelease {
 fingerprint?:string;agent_id?:string;release?:AgentInstalledRelease;
}
export interface AgentUpdatePlan {
 machine:{id:string;name:string;address:string;port:number;username:string;agent_id?:string};
 credential?:{id:string;method:string;retention?:string;expires_at?:string};
 current:AgentUpdateCurrent;target:AgentRelease;target_revision?:string;expires_at:string;
 steps:string[];warnings?:string[];
}
export type AgentUpdateStatus='awaiting_approval'|'running'|'verifying'|'succeeded'|'rolled_back'|'failed'|'unknown'|'cancelled';
export interface AgentUpdate {
 id:string;machine_id:string;agent_id:string;action:'upgrade'|'rollback';status:AgentUpdateStatus;
 plan?:AgentUpdatePlan;receipt?:Record<string,unknown>;error?:string;
 created_at:string;started_at?:string;finished_at?:string;review_url?:string;rollout_id?:string;rollout_review_url?:string;
}
export interface AgentRolloutItem {
 machine_id:string;machine_name?:string;update_id?:string;status?:AgentUpdateStatus|'pending';
 update?:AgentUpdate;error?:string;
}
export interface AgentRollout {
 id:string;status:'awaiting_approval'|'running'|'paused'|'succeeded'|'failed'|'cancelled';
 target_sha256?:string;target?:AgentRelease;items:AgentRolloutItem[];
 created_at:string;started_at?:string;finished_at?:string;error?:string;review_url?:string;
}
export interface AgentUpdateCredential {
 id:string;name?:string;is_default?:boolean;method:string;retention?:string;expires_at:string;secret_fingerprint?:string;
 revoked_at?:string;secret_cleared_at?:string;
}
export const updatePath=(machineID:string,updateID?:string)=>`/machines/${encodeURIComponent(machineID)}/agent-updates${updateID?`/${encodeURIComponent(updateID)}`:''}`;
export const releaseIdentity=(release?:AgentInstalledRelease|AgentRelease)=>release?('sha256' in release?release.sha256:release.artifact_sha256)||'':'';
export const installedRelease=(current?:AgentUpdateCurrent):AgentInstalledRelease|undefined=>current?.release??current;
export const shortIdentity=(value?:string,length=12)=>value?value.slice(0,length):'—';
export const updateIsActive=(status?:string)=>status==='running'||status==='verifying';
export const updatePlanExpired=(record?:AgentUpdate,now=Date.now())=>!record?.plan||!Number.isFinite(Date.parse(record.plan.expires_at))||Date.parse(record.plan.expires_at)<=now;
export const updateStatusText=(status:string,t:(zh:string,en:string)=>string)=>({
 awaiting_approval:t('待审阅','Awaiting review'),running:t('正在更新','Updating'),verifying:t('正在核验健康','Verifying health'),
 succeeded:t('更新成功','Updated'),rolled_back:t('已自动回退','Automatically rolled back'),failed:t('更新失败','Update failed'),
 unknown:t('结果未知，需核对','Outcome unknown; verify'),cancelled:t('已取消','Cancelled'),pending:t('尚未执行','Not started'),
}[status]??status);
export const updateStatusColor=(status:string)=>status==='succeeded'?'success':status==='failed'?'error':status==='unknown'||status==='rolled_back'?'warning':updateIsActive(status)?'processing':'default';
export const updateMessageText=(message:string,t:(zh:string,en:string)=>string)=>({
 '主机已有待审批、运行中或结果未知的 Agent 维护，请先取消、完成或核对':t('主机已有待审批、运行中或结果未知的 Agent 维护，请先取消、完成或核对','This host has Agent maintenance awaiting review, running, or with an unknown outcome. Cancel, finish, or verify it first.'),
 '平台在 Agent 维护期间重启，远端会按确认期限回退；请只读核对':t('平台在 Agent 维护期间重启，远端会按确认期限回退；请只读核对','The platform restarted during Agent maintenance. The host rolls back at its confirmation deadline. Verify the outcome read-only.'),
 '主机尚未安装 Agent，请先部署':t('主机尚未安装 Agent，请先部署','Install Agent on this host first.'),
 '主机没有有效的 Agent 控制凭据':t('主机没有有效的 Agent 控制凭据','This host has no active Agent control credential.'),
 '主机存在待执行、运行中或结果未知的任务，请先处理':t('主机存在待执行、运行中或结果未知的任务，请先处理','Resolve queued, running, or uncertain host tasks first.'),
 '主机存在安装或卸载流程，请先结束':t('主机存在安装或卸载流程，请先结束','Finish the current installation or removal workflow first.'),
 'SSH 主机的 Agent 身份与平台不一致':t('SSH 主机的 Agent 身份与平台不一致','The Agent identity on the SSH host does not match the platform.'),
 'Agent 不是空闲且健康的受管 systemd 安装，不能自动维护':t('Agent 不是空闲且健康的受管 systemd 安装，不能自动维护','Automatic maintenance requires an idle, healthy, managed systemd Agent installation.'),
 '当前 Agent 状态格式未知，不能安全升级或回退':t('当前 Agent 状态格式未知，不能安全升级或回退','The Agent state format is unknown. Automatic upgrade or rollback is unavailable.'),
 '发行架构与目标主机不一致':t('发行架构与目标主机不一致','The release architecture does not match this host.'),
 '目标发行已安装，无需重复升级':t('目标发行已安装，无需重复升级','This release artifact is already installed.'),
 '没有可安全回退的上一发行':t('没有可安全回退的上一发行','No previous release is available for automatic rollback.'),
 '主机连接或 Agent 身份已变化，原维护计划不可执行':t('主机连接或 Agent 身份已变化，原维护计划不可执行','The host connection or Agent identity changed. Create and review a new maintenance plan.'),
 '维护计划已过期，请取消并重新生成':t('维护计划已过期，请取消并重新生成','This maintenance plan expired. Cancel it and create a new plan.'),
 '所选 SSH 凭据不可用':t('所选 SSH 凭据不可用','The selected SSH credential is unavailable.'),
 '先核对正在运行或结果未知的主机':t('先核对正在运行或结果未知的主机','Verify running hosts and unknown outcomes first.'),
 '有主机失败、回退或结果未知，批次已暂停，请核对后明确继续':t('有主机失败、回退或结果未知，批次已暂停，请核对后明确继续','A host failed, rolled back, or has an unknown outcome. The rollout is paused. Verify outcomes before explicitly resuming.'),
 '批次执行条件已变化，已暂停；请检查凭据、审批期限和主机状态':t('批次执行条件已变化，已暂停；请检查凭据、审批期限和主机状态','The rollout was paused because execution conditions changed. Check credentials, plan expiry, and host state.'),
 '平台重启，批次已暂停；核对已启动主机后明确继续':t('平台重启，批次已暂停；核对已启动主机后明确继续','The platform restarted and paused this rollout. Verify hosts already started before explicitly resuming.'),
}[message]??message);
