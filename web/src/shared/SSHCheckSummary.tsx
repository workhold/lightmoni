import {Alert,Descriptions,Tag} from './ui';
import {useI18n} from './i18n';

export type SSHCheckResult={id:string;machine_id:string;credential_id:string;connected:boolean;ready:boolean;platform:string;arch:string;checks:Record<string,boolean>;error_code:string;checked_at:string;expires_at:string};

export default function SSHCheckSummary({result}:{result:SSHCheckResult}){
 const {t}=useI18n();
 const labels:Record<string,string>={linux:t('Linux 系统','Linux system'),supported_arch:t('受支持的 CPU 架构','Supported CPU architecture'),curl:'curl',tar:'tar',gzip:'gzip',sha256sum:'sha256sum',systemd:t('systemd 运行环境','Running systemd'),install_privilege:t('root 或免交互 sudo','Root or non-interactive sudo'),platform_https:t('平台 HTTPS 连通性','Platform HTTPS connectivity')};
 const errors:Record<string,string>={ssh_failed:t('SSH 连接或凭据验证失败，请检查网络、用户名和私钥。私钥必须无需口令。','SSH connection or authentication failed. Check the network, username, and private key. The key must not require a passphrase.'),host_key_mismatch:t('主机公钥与已确认的指纹不一致，请通过可信渠道核实。','The host key does not match the verified fingerprint. Verify it through a trusted channel.'),timed_out:t('检查超时，请检查网络后重试。','The check timed out. Check the network and retry.'),cancelled:t('检查已取消。','Check cancelled.'),invalid_response:t('SSH 已连接，但检查结果格式无效。','SSH connected, but the check response was invalid.'),prerequisites_missing:t('SSH 已连接，请先处理未通过的安装条件，再重新检查。','SSH connected. Resolve the failed prerequisites and check again.')};
 return <div className="lm-ssh-check-summary"><Alert showIcon type={result.ready?'success':result.connected?'warning':'error'} title={result.ready?t('SSH 已连接，安装检查通过','SSH connected; installation checks passed'):result.connected?t('SSH 已连接，安装条件不满足','SSH connected; installation prerequisites not met'):t('SSH 未连接','SSH not connected')} description={errors[result.error_code]||t('预检通过后仍需审阅部署计划；只有 Agent 激活回执才能确认安装成功。','Review the deployment plan next. Installation succeeds only when Agent activation is confirmed.')}/>
 {result.platform&&<p>{result.platform} · {result.arch}</p>}
 {result.checks.platform_https===false&&<p>{t('请为平台配置目标机器可访问的 HTTPS 外部地址，并检查网络和 TLS 证书。','Configure a platform HTTPS external URL reachable from the target host, and check the network and TLS certificate.')}</p>}
 <Descriptions size="small" column={1} items={Object.entries(labels).filter(([key])=>key in result.checks).map(([key,label])=>({key,label,children:<Tag color={result.checks[key]?'success':'error'}>{result.checks[key]?t('通过','Passed'):t('未通过','Failed')}</Tag>}))}/>
 </div>;
}
