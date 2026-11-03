import {Alert,Button,Space,Typography} from '../shared/ui';
import {useI18n} from '../shared/i18n';
import {activeMachineCredential,type SSHCredential} from './machine-credentials';

export type InstallationRecovery={
 reason:'no_credentials'|'credentials_expired'|'credentials_revoked'|'credentials_unavailable'|'insufficient_privilege'|'connection_failed'|'host_prerequisites'|'check_failed';
 next_step:'add_account'|'update_credentials'|'check_connection'|'fix_host';machine_id?:string;selection_id?:string;
};
export function missingInstallationAccount(credentials:SSHCredential[]):InstallationRecovery{
 const reason=!credentials.length?'no_credentials':credentials.every(c=>!!c.revoked_at)?'credentials_revoked':credentials.every(c=>!activeMachineCredential(c)&&!c.revoked_at)?'credentials_expired':'credentials_unavailable';
 return {reason,next_step:reason==='no_credentials'?'add_account':'update_credentials'};
}
export function installationRecovery(value:unknown,machineID:string):InstallationRecovery|undefined{
 if(!value||typeof value!=='object'||Array.isArray(value))return;
 const v=value as InstallationRecovery;
 if(v.machine_id!==machineID||!['no_credentials','credentials_expired','credentials_revoked','credentials_unavailable','insufficient_privilege','connection_failed','host_prerequisites','check_failed'].includes(v.reason)||!['add_account','update_credentials','check_connection','fix_host'].includes(v.next_step))return;
 return v;
}
export default function InstallationAccountRecovery({recovery,onAddAccount,onManageAccounts,onRetry,busy=false}:{recovery:InstallationRecovery;onAddAccount?:()=>void;onManageAccounts?:()=>void;onRetry?:()=>void;busy?:boolean}){
 const {t}=useI18n();
 const messages:Record<InstallationRecovery['reason'],[string,string]>={
  no_credentials:[t('请先配置可安装 Agent 的 SSH 账号','Configure an SSH account for Agent installation'),t('请先在主机上准备可登录的 root 或具备免交互系统管理 sudo 权限的账号，再添加该账号的密码或私钥。添加记录不会创建服务器系统账号，也不会立即安装 Agent。','Prepare a working root login or an account with non-interactive system-administration sudo on the host, then add its password or private key here. Adding a record does not create an OS account or install Agent.')],
  credentials_expired:[t('SSH 凭据已到期','SSH credentials have expired'),t('请为已登记账号补充有效密码或私钥，再重新检查。原安装设置会保留。','Add an active password or key to a registered account and check again. Your installation settings are kept.')],
  credentials_revoked:[t('SSH 凭据已撤销','SSH credentials have been revoked'),t('请重新绑定有效凭据，或添加其他可安装 Agent 的 SSH 账号。','Bind an active credential or add another SSH account that can install Agent.')],
  credentials_unavailable:[t('暂无可用于安装的 SSH 凭据','No SSH credential is available for installation'),t('请添加有效私钥或可复用密码；一次性密码不能用于安装和维护。','Add an active private key or reusable password. Single-use passwords cannot install or maintain Agent.')],
  insufficient_privilege:[t('未找到满足安装权限的账号','No checked account has installation privileges'),t('请添加主机上已有的 root 或具备免交互系统管理 sudo 权限的账号；也可请主机管理员调整现有账号权限后重新检查。平台不会自动创建账号或修改 sudo 配置。','Add an existing root login or an account with non-interactive system-administration sudo, or ask the host administrator to update an existing account and check again. The platform does not create OS accounts or change sudo settings.')],
  connection_failed:[t('未能通过 SSH 连接检查','SSH connection checks did not pass'),t('请检查主机地址、端口、网络及用户名和登录凭据。更新后重新检查；未执行安装。','Check the host address, port, network, username, and login credential. Check again after fixing them. Installation has not run.')],
  check_failed:[t('未能确认主机检查结果','Host check results could not be verified'),t('SSH 返回的检查结果不完整或无法验证。请检查登录脚本与主机环境后重新检查，当前不能据此判断需要更高权限。','SSH returned incomplete or unverifiable check results. Check login scripts and the host environment, then run the check again. These results do not establish a need for higher privileges.')],
  host_prerequisites:[t('请先处理主机安装条件','Resolve the host installation prerequisites'),t('请查看下方未通过的系统、依赖或平台连通性检查。更换账号不能绕过这些条件，处理后再重新检查。','Review the failed system, dependency, or platform connectivity checks below. Another account cannot bypass them; fix the host and check again.')],
 };
 const [title,message]=messages[recovery.reason];
 return <Alert className='lm-machine-form-notice' showIcon type='warning' title={title} description={<><Typography.Paragraph>{message}</Typography.Paragraph><Space wrap>
  {onAddAccount&&<Button type={['no_credentials','insufficient_privilege'].includes(recovery.reason)?'primary':'default'} disabled={busy} onClick={onAddAccount}>{t('添加 SSH 账号','Add SSH account')}</Button>}
  {onManageAccounts&&<Button type={recovery.next_step==='update_credentials'?'primary':'default'} disabled={busy} onClick={onManageAccounts}>{t('管理账号与凭据','Manage accounts and credentials')}</Button>}
  {onRetry&&<Button disabled={busy} onClick={onRetry}>{t('重新检查','Check again')}</Button>}
 </Space></>}/>;
}
