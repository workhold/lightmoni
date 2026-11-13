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
 machine:{id:string;name:string;address:string;port:number;agent_id?:string};
 ssh_account:{id:string;username:string;revision:number};
 credential?:{id:string;method:string;retention?:string;expires_at?:string};
 current:AgentUpdateCurrent;target:AgentRelease;target_revision?:string;expires_at:string;
 steps:string[];warnings?:string[];
}
export type AgentUpdateStatus='awaiting_approval'|'running'|'verifying'|'succeeded'|'rolled_back'|'failed'|'unknown'|'cancelled';
export interface AgentUpdate {
 id:string;machine_id:string;agent_id:string;action:'upgrade'|'rollback';status:AgentUpdateStatus;
 plan?:AgentUpdatePlan;receipt?:Record<string,unknown>;error?:string;recovery_revision?:string;recovery_requires_verification?:boolean;
 events?:{at:string;stage:string}[];
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
 id:string;account_id:string;username:string;account_revision:number;name?:string;is_default?:boolean;method:string;retention?:string;expires_at:string;secret_fingerprint?:string;
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
 succeeded:t('更新成功','Updated'),rolled_back:t('已回退原程序','Previous runtime restored'),failed:t('更新失败','Update failed'),
 unknown:t('结果未知，需核对','Outcome unknown; verify'),cancelled:t('已取消','Cancelled'),pending:t('尚未执行','Not started'),
}[status]??status);
export const updateStatusColor=(status:string)=>status==='succeeded'?'success':status==='failed'?'error':status==='unknown'||status==='rolled_back'?'warning':updateIsActive(status)?'processing':'default';
export const updateMessageText=(message:string,t:(zh:string,en:string)=>string)=>({
 '主机已有待审批、运行中或结果未知的 Agent 维护，请先取消、完成或核对':t('主机已有待审批、运行中或结果未知的 Agent 维护，请先取消、完成或核对','This host has Agent maintenance awaiting review, running, or with an unknown outcome. Cancel, finish, or verify it first.'),
 '平台在 Agent 维护期间重启，远端会按确认期限回退；请只读核对':t('平台在 Agent 维护期间重启，请只读核对原事务；维护进程已停止时可审阅恢复。','The platform restarted during Agent maintenance. Verify the original transaction read-only; review recovery if its process has stopped.'),
 '维护连接中断或回执无效；远端可能仍运行，请等待自动回退后只读核对':t('维护连接中断或回执无效，请只读核对原事务；维护进程可能仍在运行，停止后可审阅恢复。','The maintenance connection was interrupted or its receipt is invalid. Verify the original transaction read-only. Its process may still be running; review recovery once it has stopped.'),
 '维护结果待核对；进程已停止时可审阅恢复。不会自动重放维护。':t('维护结果待核对；进程已停止时可审阅恢复。不会自动重放维护。','The maintenance outcome needs verification. Review recovery once its process has stopped. Maintenance is never replayed automatically.'),
 'agent_update_read_timeout':t('读取超时，已保留最后状态；可重新读取或关闭窗口。','The read timed out. The last state is retained; retry the read or close this dialog.'),
 'agent_update_recovery_revision_changed':t('恢复条件已变化，请刷新原记录并重新审阅恢复影响。','Recovery conditions changed. Refresh the original record and review the recovery impact again.'),
 'agent_update_recovery_running':t('维护进程仍在运行，未执行恢复；请稍后只读核对。','The maintenance process is still running. Recovery was not performed; verify the outcome read-only later.'),
 'agent_update_recovery_unverified':t('恢复结果无法完整核实，仍保留未知状态。请先只读核对原事务，必要时检查主机现场。','The recovery outcome could not be fully verified and remains unknown. Verify the original transaction read-only first; inspect the host evidence if needed.'),
 'agent_update_recovery_verification_required':t('上次恢复结果尚未核对，请先使用“只读核对结果”，不要重复提交恢复。','The previous recovery outcome has not been verified. Use Verify outcome (read-only) before submitting another recovery.'),
 'agent_update_recovery_identity_changed':t('Agent 身份、运行模式或权限代次已变化，不能按原审批恢复；请核对主机现场。','The Agent identity, runtime mode, or permission generation changed. Recovery cannot use the original approval. Inspect the host evidence.'),
 'agent_update_recovery_runner_unavailable':t('平台恢复维护器不可用，请修复发行包后刷新原记录。','The platform recovery maintainer is unavailable. Fix the release artifact, then refresh the original record.'),
 'reconciliation_credential_changed':t('核验使用的 SSH 账户或凭据已变化，请重新选择并检查。','The SSH account or credential used for verification changed. Select and check it again.'),
 '恢复结果待核对；请先只读核对，不要重复派发恢复':t('恢复结果待核对；请先只读核对，不要重复派发恢复','The recovery outcome needs verification. Verify it read-only before dispatching another recovery.'),
 '平台在 Agent 维护期间重启，请先只读核对；进程已停止时可审阅恢复，不会自动重放维护':t('平台在 Agent 维护期间重启，请先只读核对；进程已停止时可审阅恢复，不会自动重放维护','The platform restarted during Agent maintenance. Verify the outcome read-only; review recovery once its process has stopped. Maintenance is never replayed automatically.'),
 '平台观察期限已结束，维护结果待核对；请先只读核对，进程已停止时可审阅恢复':t('平台观察期限已结束，维护结果待核对；请先只读核对，进程已停止时可审阅恢复','The platform observation period ended. Verify the maintenance outcome read-only; review recovery once its process has stopped.'),
 '维护结果暂不可确认；请先只读核对，进程已停止时可审阅恢复':t('维护结果暂不可确认；请先只读核对，进程已停止时可审阅恢复','The maintenance outcome cannot yet be confirmed. Verify it read-only; review recovery once its process has stopped.'),
 '维护连接中断或回执无效；远端可能仍运行，请先只读核对，进程已停止时可审阅恢复':t('维护连接中断或回执无效；远端可能仍运行，请先只读核对，进程已停止时可审阅恢复','The maintenance connection was interrupted or its receipt is invalid. Its process may still be running. Verify the outcome read-only; review recovery once the process has stopped.'),
 '已核对维护进程停止且原程序健康，本次维护在切换前中断':t('已核对维护进程停止且原程序健康，本次维护在切换前中断','The maintenance process is confirmed stopped and the original runtime is healthy. This maintenance was interrupted before switching runtimes.'),
 '目标程序未通过健康确认，已恢复原程序':t('目标程序未通过健康确认，已恢复原程序','The target runtime did not pass health confirmation. The previous runtime was restored.'),
 '目标程序未通过健康确认，已恢复原程序；原服务此前停止，现仍停止':t('目标程序未通过健康确认，已恢复原程序；原服务此前停止，现仍停止','The target runtime did not pass health confirmation. The previous runtime was restored; its service was stopped before maintenance and remains stopped.'),
 'Failed to fetch':t('连接中断，未收到服务器确认；请核对原记录。','The connection was interrupted without server confirmation. Verify the original record.'),
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
