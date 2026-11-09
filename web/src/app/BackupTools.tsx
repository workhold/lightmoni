import {useEffect,useState} from 'react';
import {DownloadOutlined} from '@ant-design/icons';
import {Alert,Button,Descriptions,Modal,Space,Spin,Tabs,Typography} from '../shared/ui';
import {api} from '../shared/api';
import {useI18n} from '../shared/i18n';
import CodeEditor from '../shared/CodeEditor';
import type {Resource} from './ops/model';

type Tool={available:boolean;download_url:string;sha256:string|null};
export function BackupContent({application}:{application?:Resource}) {
 const {t}=useI18n(),[tool,setTool]=useState<Tool>(),[error,setError]=useState('');
 useEffect(()=>{const c=new AbortController();void api<Tool>('/backup-tool',{signal:c.signal}).then(setTool).catch(e=>{if(!c.signal.aborted)setError((e as Error).message)});return()=>c.abort()},[]);
 const selection=application?'--application '+application.id:'--project lightmoni';
 const exportCommand=`python3 lightmoni-backup.py export ${selection}\npython3 lightmoni-backup.py export ${selection} --helper-image debian:bookworm-slim --execute --confirm-stop --include-images --output backup.lmb.tar.gz\npython3 lightmoni-backup.py verify backup.lmb.tar.gz`;
 const restoreCommand='python3 lightmoni-backup.py restore backup.lmb.tar.gz --target-project lightmoni-restored --directory /root/lightmoni-restored --helper-image debian:bookworm-slim --execute --confirm-empty-targets';
 const scheduleCommand=`python3 lightmoni-backup.py schedule --application ${application?.id??'<application-id>'} --directory /root/lightmoni-backup-schedule --output-directory /root/lightmoni-backups --s3-config /root/s3.json --credentials-file /root/backup-s3.env --on-calendar daily`;
 return <Space direction="vertical" size="middle" style={{width:'100%'}}>
  <Typography.Paragraph>{application?t('在应用所在主机运行备份工具，将同机全部容器的持久挂载、运行配置和属主权限归入一个文件。多个主机分别备份。','Run the backup tool on each application host to archive all local containers’ persistent mounts, configuration and ownership in one file. Back up each host separately.'):t('在原部署主机导出中心与 ClickHouse 的完整数据，校验后传输到新机器，恢复到全新数据卷。','Export the center and ClickHouse data on the source host, verify the archive, transfer it to the new host and restore into fresh volumes.')}</Typography.Paragraph>
  <Alert type="warning" showIcon title={t('备份包含密码和主密钥，请私密保存','Backups contain passwords and master keys; store them privately')} description={application?t('先在平台停止应用并暂停部署操作。导出确认后会停止所选容器，完成后恢复原运行状态；检测到并发启动或配置变化会拒绝备份。','Stop the application in the platform and pause deployment operations first. Confirmed exports stop selected containers and restore their previous running state afterward. Concurrent starts or configuration changes reject the backup.'):t('迁移导出会停止原中心和 ClickHouse，并保持停止以避免双中心调度。新部署验证通过后再切换域名；原数据保留。外部 ClickHouse 需要单独迁移。','Migration exports stop the source center and ClickHouse and leave them stopped to prevent two schedulers. Switch the domain after validating the new deployment; source data is retained. External ClickHouse requires a separate migration.')}/>
  {error&&<Alert type="error" title={error}/>}<Spin spinning={!tool&&!error}><Space wrap><Button icon={<DownloadOutlined/>} type="primary" href={tool?.available?tool.download_url:undefined} disabled={!tool?.available}>{t('下载备份工具','Download backup tool')}</Button><Typography.Text type="secondary">Python 3.9+ · Docker · Docker Compose</Typography.Text></Space></Spin>
  {tool&&!tool.available&&<Alert type="info" title={t('当前发行包尚未包含备份工具','This release does not include the backup tool yet')}/>}
  {tool?.sha256&&<Descriptions size="small" column={1} items={[{key:'sha',label:'SHA256',children:<Typography.Text copyable style={{wordBreak:'break-all'}}>{tool.sha256}</Typography.Text>}]}/>}
  <Tabs items={[
   {key:'export',label:t('导出与下载','Export & download'),children:<><Typography.Paragraph>{t('先预览，再确认停机导出。helper 镜像需已在主机存在且包含 tar，不自动拉取。生成后可通过文件传输工具下载归档。','Preview first, then confirm the stopped export. The helper image must already exist locally and include tar; images are not pulled automatically. Download the resulting archive with your file transfer tool.')}</Typography.Paragraph><CodeEditor readOnly language="shell" height={200} value={exportCommand} ariaLabel={t('导出命令','Export commands')}/></>},
   {key:'restore',label:t('恢复与迁移','Restore & migrate'),children:<><Typography.Paragraph>{t('先核对归档摘要。恢复拒绝已有项目或同名数据卷，验证文件内容和属主权限后生成 compose.json，不自动启动。再启动并核对登录、历史遥测和节点连接。应用恢复为独立编排，需重新审阅接管；不复制主机 Agent 身份。','Verify the archive digest first. Restore rejects an existing project or volume names, verifies contents and ownership, then writes compose.json without starting containers. Start and check sign-in, historical telemetry and node connections. Restored applications are independent Compose projects and require reviewed adoption; host Agent identities are not copied.')}</Typography.Paragraph><CodeEditor readOnly language="shell" height={170} value={restoreCommand} ariaLabel={t('恢复命令','Restore command')}/></>},
   {key:'schedule',label:t('定期云备份','Scheduled cloud backups'),children:<><Typography.Paragraph>{t('在 Linux 主机准备 root 保护的脚本、私有目录、S3 配置和权限 0600 的凭据文件。生成 systemd service/timer 后审阅停机窗口，再由 root 安装启用；这是独立于平台计划的本机持续授权。云存储密码不保存到浏览器，工具不会自动安装计划。','On Linux, prepare a root-protected script, private directories, S3 configuration and a mode 0600 credential file. Review the downtime window before root installs and enables the generated systemd service/timer. This is a continuing local grant, independent of platform schedules. Cloud secrets are not saved in the browser; the tool does not install schedules.')}</Typography.Paragraph><CodeEditor readOnly language="shell" height={170} value={scheduleCommand} ariaLabel={t('云备份计划命令','Cloud backup schedule command')}/><Typography.Paragraph type="secondary">{t('S3 兼容存储使用 HTTPS，单对象上限 5 GiB，上传后完整回读校验；本地归档采用流式写入。','S3-compatible storage uses HTTPS with a 5 GiB single-object limit and full readback verification. Local archives are streamed.')}</Typography.Paragraph></>},
  ]}/>
 </Space>;
}

export function ApplicationBackupDialog({application,onClose}:{application?:Resource;onClose:()=>void}) {
 const {t}=useI18n();return <Modal open={!!application} destroyOnHidden width={900} title={t('应用备份','Application backup')+(application?' · '+application.name:'')} onCancel={onClose} footer={<Button onClick={onClose}>{t('关闭','Close')}</Button>}>{application&&<BackupContent application={application}/>}</Modal>;
}
export default function BackupTools(){const {t}=useI18n();return <div className="lm-page"><h1>{t('备份与迁移','Backup & migration')}</h1><BackupContent/></div>}
