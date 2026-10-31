import {useRef,useState} from 'react';
import {Alert,Button,Checkbox,Descriptions,Space,Typography} from '../shared/ui';
import {api} from '../shared/api';
import {useI18n} from '../shared/i18n';

type Artifact={filename:string;sha256:string;script:string};

/** This downloads a fixed, authenticated artifact; it never executes on a host. */
export default function AgentUninstallManual(){
 const {t}=useI18n(),[artifact,setArtifact]=useState<Artifact>(),[purge,setPurge]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const pending=useRef(false);
 const load=async()=>{
  if(pending.current)return;pending.current=true;setBusy(true);setError('');setArtifact(undefined);
  try{
   const next=await api<Artifact>('/agent-maintenance/uninstaller');
   if(next.filename!=='lightmoni-agent-uninstall.sh'||!/^[a-f0-9]{64}$/i.test(next.sha256)||typeof next.script!=='string'||!next.script)throw Error(t('卸载脚本返回格式不正确','Invalid uninstall script response'));
   const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(next.script));
   const actual=Array.from(new Uint8Array(digest),value=>value.toString(16).padStart(2,'0')).join('');
   if(actual!==next.sha256.toLowerCase())throw Error(t('卸载脚本 SHA256 校验失败','Uninstall script SHA256 verification failed'));
   setArtifact(next);
  }catch(e){setError(e instanceof Error?e.message:t('读取卸载脚本失败','Could not load the uninstall script'))}finally{pending.current=false;setBusy(false)}
 };
 const download=()=>{if(!artifact)return;const url=URL.createObjectURL(new Blob([artifact.script],{type:'text/x-shellscript;charset=utf-8'})),link=document.createElement('a');link.href=url;link.download=artifact.filename;document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000)};
 const command=`sudo sh lightmoni-agent-uninstall.sh${purge?' --purge':''}`;
 const installedCommand=`sudo sh /usr/local/sbin/lightmoni-agent-uninstall${purge?' --purge':''}`;
 return <div>
  <Alert showIcon type="info" title={t('离线手动卸载','Offline manual uninstall')} description={t('下载固定脚本并传到目标主机，使用 root 权限在 Linux/systemd 主机执行。脚本不连接平台；下载或复制命令不会卸载主机，也不会撤销平台凭据。完成后需在平台核对并处理对应身份。','Download the fixed script, copy it to the host, and execute it as root on Linux/systemd. The script does not contact the platform. Downloading or copying does not uninstall anything or revoke platform credentials. Verify the result and handle the matching identity in the platform afterward.')}/>
  <p>{t('脚本会校验受管服务、固定路径、未完成任务和生命周期锁；不提供跳过这些检查的强制参数。业务服务、业务数据和系统用户保留。','The script checks managed service ownership, fixed paths, unfinished tasks, and lifecycle locks. These checks cannot be bypassed. Business services, business data, and the system user are retained.')}</p>
  <Checkbox checked={purge} onChange={event=>setPurge(event.target.checked)}>{t('同时清除 Agent 配置、身份和缓存（--purge）','Also purge Agent configuration, identity, and cache (--purge)')}</Checkbox>
  <Typography.Paragraph type="secondary">{purge?t('将清除 /etc/lightmoni-agent 和 /var/lib/lightmoni-agent；不可用于存放业务数据。','Removes /etc/lightmoni-agent and /var/lib/lightmoni-agent; these paths must not contain business data.'):t('默认保留 /etc/lightmoni-agent 和 /var/lib/lightmoni-agent。','Retains /etc/lightmoni-agent and /var/lib/lightmoni-agent by default.')}</Typography.Paragraph>
  <Space wrap><Button loading={busy} onClick={()=>void load()}>{t('获取卸载脚本','Get uninstall script')}</Button>{artifact&&<Button onClick={download}>{t('下载卸载脚本','Download uninstall script')}</Button>}</Space>
  {artifact&&<Descriptions className="lm-machine-form-notice" column={1} size="small" items={[
   {key:'sha',label:'SHA256',children:<Typography.Text code copyable={{text:artifact.sha256}} className="lm-machine-path">{artifact.sha256}</Typography.Text>},
   {key:'command',label:t('下载后执行','Execute after copying'),children:<Typography.Text code copyable={{text:command}} className="lm-machine-path">{command}</Typography.Text>},
  ]}/>}
  <Typography.Paragraph className="lm-machine-form-notice">{t('新安装的 Agent 也会保存本机卸载器：','New Agent installations also save a local uninstaller: ')}<Typography.Text code copyable={{text:installedCommand}} className="lm-machine-path">{installedCommand}</Typography.Text></Typography.Paragraph>
  {error&&<Alert role="alert" type="error" showIcon title={error}/>}
 </div>;
}
