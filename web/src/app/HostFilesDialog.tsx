import {lazy,Suspense,useEffect,useRef,useState} from 'react';
import {ArrowUpOutlined,FileOutlined,FileAddOutlined,FolderOutlined,FolderAddOutlined,MoreOutlined,ReloadOutlined,SaveOutlined,UploadOutlined} from '@ant-design/icons';
import {Alert,App,Breadcrumb,Button,Dropdown,Input,Modal,Select,Space,Spin,Table,Tag,Typography} from 'antd';
import {api,ApiError} from '../shared/api';
import {useI18n} from '../shared/i18n';
import {defaultMachineCredential,reusableMachineCredential,sshCredentialLabel,type SSHAccount,type SSHCredential} from './machine-credentials';
import './host-resources.css';

const CodeEditor=lazy(()=>import('../shared/CodeEditor'));

type Host={id:string;name:string;default_account_id?:string;accounts?:SSHAccount[]};
type Credential=SSHCredential;
type Entry={name:string;type:'directory'|'file'|'symlink'|'special';size:number;mode:string;modified_at:string;version:string};
type Directory={machine_id:string;path:string;entries:Entry[];truncated:boolean;version:string};
type Document={machine_id:string;path:string;content:string;version:string;size:number};
type Metadata={machine_id:string;path:string;type:'file'|'directory';version:string;size:number;mode:string;empty?:boolean};
type Maintenance={operation:'create'|'mkdir'|'rename'|'remove'|'chmod';path:string;snapshot:Metadata;name:string;mode:string;uncertain?:boolean};
type FileSession={id:string;credentialID:string;idleTimeoutMs:number;expiresAt:number;lastUsed:number;initialDirectory?:Directory};
type FileSessionResponse={machine_id:string;credential_id:string;session_id:string;idle_timeout_ms:number;expires_at:string;initial_directory?:Directory};
const join=(path:string,name:string)=>(path==='/'?'':path)+'/'+name;
const parent=(path:string)=>path.slice(0,path.lastIndexOf('/'))||'/';
const size=(bytes:number)=>bytes<1024?bytes+' B':bytes<1048576?(bytes/1024).toFixed(1)+' KiB':(bytes/1048576).toFixed(1)+' MiB';

export default function HostFilesDialog({machine,onClose}:{machine:Host;onClose:()=>void}){
 const {t,language}=useI18n(),{modal,message}=App.useApp();
 const [credentials,setCredentials]=useState<Credential[]>([]),[credential,setCredential]=useState<string>(),[directory,setDirectory]=useState<Directory>(),[pathInput,setPathInput]=useState('/'),[busy,setBusy]=useState(false),[error,setError]=useState(''),[document,setDocument]=useState<Document>(),[content,setContent]=useState(''),[filter,setFilter]=useState(''),[upload,setUpload]=useState<{file:File;path:string;version:string|null}>();
 const [maintenance,setMaintenance]=useState<Maintenance>();
 const alive=useRef(true),pending=useRef(false),abort=useRef<AbortController|null>(null),fileInput=useRef<HTMLInputElement>(null),fileSession=useRef<FileSession|undefined>(undefined);
 const dirty=!!document&&content!==document.content;
 const errorText=(e:unknown)=>{
  const code=e instanceof Error?e.message:'';
  const messages:Record<string,string>={
   '此主机有终端、检查或部署正在进行，请先结束后重试':t('此主机有终端、检查或部署正在进行，请先结束后重试','This host has an active terminal, check, or deployment. Finish it and retry.'),
   '连接凭据已撤销':t('连接凭据已撤销，请重新选择有效凭据','The credential was revoked. Select an active credential.'),
   '连接凭据已过期或有效期无效':t('连接凭据已过期，请重新选择有效凭据','The credential expired. Select an active credential.'),
   '连接凭据秘密已清除，请添加新凭据':t('连接凭据秘密已清除，请添加新凭据','The credential secret was cleared. Add a new credential.'),
   file_connections_limit:t('文件连接已达上限，请稍后重试','The file connection limit was reached. Retry shortly.'),
   file_already_exists:t('目标名称已存在，请使用其他名称；不会覆盖已有对象。','The destination exists. Choose another name; existing entries are not overwritten.'),
   file_directory_not_empty:t('仅可删除空目录。请先检查并逐项处理目录内容。','Only empty directories can be removed. Review and handle their contents first.'),
   file_directory_limit:t('目录超过 2000 项，无法完整核对版本。请先缩小维护范围。','This directory exceeds 2,000 entries and its version cannot be fully verified. Reduce the maintenance scope first.'),
   file_action_unverified:t('操作结果未知，请关闭确认窗口并刷新目录，核对实际结果后再操作。','The operation result is unknown. Close this confirmation and refresh the directory to inspect the result before continuing.'),
   file_root_mutation_forbidden:t('不允许修改根目录。','The root directory cannot be modified.'),
   invalid_file_name:t('名称不能为空，不能包含路径分隔符、控制字符或使用 . 和 ..。','Enter a name without path separators or control characters; . and .. are not allowed.'),
   invalid_file_mode:t('请输入 0000—0777 范围内的八进制权限，例如 0644 或 0755。','Enter an octal mode from 0000 to 0777, such as 0644 or 0755.'),
   human_admin_session_required:t('请使用管理员浏览器会话登录','Sign in with an administrator browser session.'),
   '请先登录':t('登录已过期，请重新登录','Your session expired. Sign in again.'),
   file_changed:t('文件已被其他操作修改，请保留草稿并重新打开文件后核对。','The file changed remotely. Keep your draft and reopen the file to compare.'),file_not_utf8_text:t('此文件不是 UTF-8 文本，无法在线编辑。','This file is not UTF-8 text and cannot be edited online.'),file_too_large:t('文件超过上限：文本编辑 1 MiB，上传 8 MiB。','File exceeds the limit: 1 MiB for editing, 8 MiB for upload.'),file_permission_denied:t('当前 SSH 账户没有此路径的权限。','The selected SSH account does not have permission for this path.'),file_type_unsupported:t('仅支持普通文件，不可打开符号链接或特殊文件。','Only regular files are supported; links and special files cannot be opened.'),file_not_found:t('文件或目录不存在，请刷新目录。','The file or directory does not exist. Refresh the directory.'),file_write_unverified:t('写入结果未确认，请先刷新并重新读取文件核对；草稿已保留。','The write is unverified. Refresh and reopen the file to verify; your draft is retained.'),file_atomic_operation_unsupported:t('此 SSH 服务不支持安全原子发布，未覆盖文件。','This SSH server does not support safe atomic publication. The file was not overwritten.'),file_ssh_failed:t('SSH 连接失败，请检查主机地址和登录凭据。','SSH connection failed. Check the host address and credentials.'),host_key_mismatch:t('SSH 主机指纹不匹配，连接已停止。','The SSH host fingerprint does not match. Connection stopped.'),file_sftp_unavailable:t('此 SSH 服务未启用 SFTP。','SFTP is not enabled on this SSH server.'),file_operation_failed:t('文件操作失败，请检查路径权限并刷新核对。','File operation failed. Check path permissions and refresh to verify.'),invalid_file_path:t('请输入有效的绝对路径。','Enter a valid absolute path.'),file_operation_timeout:t('操作超时，请刷新核对远端文件。','Operation timed out. Refresh to verify the remote file.'),file_connection_closed:t('SSH 连接已关闭，请刷新后重试。','The SSH connection closed. Refresh and retry.'),file_credential_changed:t('SSH 账户或凭据已变化，请重新打开文件管理。','The SSH account or credential changed. Reopen file management.'),file_session_expired:t('文件连接已过期，请重新执行操作。','The file connection expired. Retry the operation.'),file_session_busy:t('文件连接正在处理其他请求，请稍后重试。','The file connection is busy. Retry shortly.'),file_session_forbidden:t('此文件连接不属于当前登录会话。','This file connection belongs to another login session.')};
  return messages[code]||code||t('操作失败','Operation failed');
 };
 const endpoint=(operation:string,path:string,key=credential)=>`/machines/${encodeURIComponent(machine.id)}/${operation}?`+new URLSearchParams({path,...(key?{credential_id:key}:{})});
 const releaseSession=()=>{
  const current=fileSession.current;fileSession.current=undefined;
  if(!current)return Promise.resolve();
  return fetch(`/api/v1/machines/${encodeURIComponent(machine.id)}/file-session`,{method:'DELETE',credentials:'include',keepalive:true,headers:{'X-LightMoni-File-Session':current.id}}).then(()=>{},()=>{});
 };
 const ensureSession=async(key:string|undefined,signal?:AbortSignal,initialPath?:string):Promise<FileSession>=>{
  if(!key)throw Error(t('请选择有效的可复用凭据','Select an active reusable credential'));
  const current=fileSession.current,now=Date.now();
  if(current&&(current.credentialID!==key||now>=current.expiresAt-2000||now-current.lastUsed>=current.idleTimeoutMs-2000))await releaseSession();
  if(fileSession.current)return fileSession.current;
  const open=(path?:string)=>api<FileSessionResponse>(`/machines/${encodeURIComponent(machine.id)}/file-session`,{method:'POST',signal,body:JSON.stringify({credential_id:key,...(path?{initial_path:path}:{})})});
  let created:FileSessionResponse;
  try{created=await open(initialPath)}
  catch(error){
   // During a rolling update an older server rejects the optional field.
   if(!initialPath||!(error instanceof ApiError)||error.status!==400||error.message!=='invalid_file_session')throw error;
   created=await open();
  }
  if(created.machine_id!==machine.id||created.credential_id!==key||!/^[A-Za-z0-9_-]{20,128}$/.test(created.session_id))throw Error(t('文件连接与目标主机不匹配','The file connection does not match this host'));
  const next:FileSession={id:created.session_id,credentialID:key,idleTimeoutMs:created.idle_timeout_ms,expiresAt:Date.parse(created.expires_at),lastUsed:Date.now(),initialDirectory:created.initial_directory};
  fileSession.current=next;
  if(initialPath&&created.initial_directory&&(created.initial_directory.machine_id!==machine.id||created.initial_directory.path!==initialPath||!Array.isArray(created.initial_directory.entries)||typeof created.initial_directory.version!=='string')){
   await releaseSession();throw Error(t('目录响应与目标主机不匹配','The directory response does not match this host'));
  }
  if(!alive.current||signal?.aborted){await releaseSession();throw new DOMException('Aborted','AbortError')}
  return next;
 };
 const fileApi=async<T,>(operation:string,path:string,init:RequestInit={},key=credential,query?:Record<string,string>):Promise<T>=>{
  const current=await ensureSession(key,init.signal??undefined);
  const url=endpoint(operation,path,key)+(query?'&'+new URLSearchParams(query):'');
  const send=(session:FileSession)=>api<T>(url,{...init,headers:{...Object.fromEntries(new Headers(init.headers)), 'X-LightMoni-File-Session':session.id}});
  try{const value=await send(current);current.lastUsed=Date.now();return value}
  catch(error){
   if(error instanceof ApiError&&['file_session_expired','file_credential_changed','file_connection_closed','file_operation_timeout'].includes(error.message)){
    if(fileSession.current===current)fileSession.current=undefined;
    if(error.message==='file_session_expired'&&(!init.method||init.method==='GET')){
     const renewed=await ensureSession(key,init.signal??undefined);const value=await send(renewed);renewed.lastUsed=Date.now();return value;
    }
   }
   throw error;
  }
 };
 const guarded=async(work:(signal:AbortSignal)=>Promise<void>)=>{
  if(pending.current)return;pending.current=true;setBusy(true);setError('');message.destroy();const controller=new AbortController();abort.current=controller;
  try{await work(controller.signal)}catch(e){if(alive.current&&!controller.signal.aborted)setError(errorText(e))}finally{if(abort.current===controller){pending.current=false;if(alive.current)setBusy(false)}}
 };
 const checked=<T extends {machine_id:string}>(value:T)=>{if(value.machine_id!==machine.id)throw Error(t('响应与目标主机不匹配','The response does not match this host'));return value};
 const readDirectory=async(path:string,key:string|undefined,signal:AbortSignal)=>{
  const next=checked(await fileApi<Directory>('files',path,{signal},key));
  if(alive.current&&!signal.aborted){setDirectory(next);setPathInput(next.path)}
 };
 const readInitialDirectory=async(key:string,signal:AbortSignal)=>{
  const session=await ensureSession(key,signal,'/');
  const initial=session.initialDirectory;
  session.initialDirectory=undefined;
  if(initial){if(alive.current&&!signal.aborted){setDirectory(initial);setPathInput(initial.path)}}
  else await readDirectory('/',key,signal);
 };
 useEffect(()=>{
  alive.current=true;
  void guarded(async signal=>{
   const completeAccounts=Array.isArray(machine.accounts)&&machine.accounts.every(account=>Array.isArray(account.credentials));
   const detail=completeAccounts?undefined:await api<{machine:Host;credentials:Credential[]}>(`/machines/${encodeURIComponent(machine.id)}`,{signal});
   if(!alive.current||signal.aborted)return;
   if(detail&&detail.machine.id!==machine.id)throw Error(t('主机详情身份不匹配','Host details do not match'));
   const host=detail?.machine??machine;
   if(host.accounts?.some(account=>account.machine_id!==machine.id||account.credentials?.some(value=>value.account_id!==account.id||value.username!==account.username||value.account_revision!==account.revision)))throw Error(t('主机详情身份不匹配','Host details do not match'));
   const available=(detail?.credentials??host.accounts?.flatMap(account=>account.credentials??[])??[]).filter(reusableMachineCredential);
   setCredentials(available);
   const selected=defaultMachineCredential(available,host)??available[0]?.id;
   setCredential(selected);
   if(!selected)return;
   try{await readInitialDirectory(selected,signal)}
   catch(error){
    // A list snapshot can predate a credential change. Refresh the choices
    // only after a rejected open; never retry SSH under a different identity.
    if(!detail&&error instanceof ApiError&&['连接凭据已撤销','连接凭据已过期或有效期无效','连接凭据秘密已清除，请添加新凭据','file_credential_changed'].includes(error.message)){
     try{
      const fresh=await api<{machine:Host;credentials:Credential[]}>(`/machines/${encodeURIComponent(machine.id)}`,{signal});
      if(fresh.machine.id===machine.id&&alive.current&&!signal.aborted){const options=fresh.credentials.filter(reusableMachineCredential);setCredentials(options);if(!options.some(value=>value.id===selected))setCredential(undefined)}
     }catch{/* Keep the original credential rejection visible. */}
    }
    throw error;
   }
  });
  return()=>{alive.current=false;abort.current?.abort();pending.current=false;void releaseSession()};
 },[machine.id]);
 useEffect(()=>{if(!dirty)return;const listener=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue=''};window.addEventListener('beforeunload',listener);return()=>window.removeEventListener('beforeunload',listener)},[dirty]);
 const discard=(action:()=>void)=>{if(busy)return;if(!dirty){action();return}modal.confirm({title:t('放弃未保存的修改？','Discard unsaved changes?'),content:t('当前文件的修改尚未保存。','Changes to the current file have not been saved.'),okText:t('放弃修改','Discard changes'),cancelText:t('继续编辑','Keep editing'),onOk:action})};
 const navigate=(path:string)=>discard(()=>void guarded(async signal=>{await readDirectory(path,credential,signal);if(alive.current&&!signal.aborted){setDocument(undefined);setContent('');setFilter('')}}));
 const openFile=(entry:Entry)=>discard(()=>void guarded(async signal=>{const next=checked(await fileApi<Document>('file',join(directory!.path,entry.name),{signal}));if(alive.current&&!signal.aborted){setDocument(next);setContent(next.content)}}));
 const save=()=>void guarded(async signal=>{
  if(!document)return;const original=document;
  const saved=checked(await fileApi<{machine_id:string;path:string;version:string;size:number}>('file',original.path,{method:'PUT',signal,body:JSON.stringify({content,expected_version:original.version,confirmed:true})}));
  if(alive.current&&!signal.aborted){setDocument({...original,...saved,content});void message.success(t('文件已保存并核对','File saved and verified'))}
  // A directory refresh failure must not turn the verified write into a retry.
  await readDirectory(directory!.path,credential,signal);
 });
 const selectUpload=(file:File)=>void guarded(async signal=>{
  if(file.size>8*1048576)throw Error('file_too_large');
  if(!file.name||file.name==='.'||file.name==='..'||/[\/\x00-\x1f\x7f]/.test(file.name))throw Error('invalid_file_path');
  const path=join(directory!.path,file.name),found=checked(await fileApi<{machine_id:string;path:string;version:string|null}>('file-version',path,{signal}));
  if(alive.current&&!signal.aborted)setUpload({file,path,version:found.version});
 });
 const sendUpload=()=>void guarded(async signal=>{
  if(!upload)return;const target=upload;
  const response=await fileApi<{machine_id:string;path:string;version:string;size:number}>('file-upload',target.path,{method:'POST',signal,headers:{'Content-Type':'application/octet-stream'},body:target.file},credential,{expected_version:target.version??'new',confirmed:'true'});checked(response);
  if(alive.current&&!signal.aborted){setUpload(undefined);if(document?.path===target.path){setDocument(undefined);setContent('')}void message.success(t('上传已完成并核对','Upload completed and verified'))}
  await readDirectory(directory!.path,credential,signal);
 });
 const prepareAction=(operation:Maintenance['operation'],entry?:Entry)=>discard(()=>void guarded(async signal=>{
  const path=entry?join(directory!.path,entry.name):directory!.path;
  const snapshot=checked(await fileApi<Metadata>('file-metadata',path,{signal}));
  if(operation==='remove'&&snapshot.type==='directory'&&!snapshot.empty)throw Error('file_directory_not_empty');
  if(alive.current&&!signal.aborted)setMaintenance({operation,path:snapshot.path,snapshot,name:entry?.name??'',mode:(parseInt(snapshot.mode,8)&0o777).toString(8).padStart(4,'0')});
 }));
 const confirmAction=()=>void guarded(async signal=>{
  if(!maintenance||maintenance.uncertain)return;const current=maintenance,isNew=['create','mkdir'].includes(current.operation);
  if((isNew||current.operation==='rename')&&(!current.name||current.name==='.'||current.name==='..'||/[\\/\x00-\x1f\x7f]/.test(current.name)||new TextEncoder().encode(current.name).length>255))throw Error('invalid_file_name');
  if(current.operation==='chmod'&&!/^0?[0-7]{3}$/.test(current.mode))throw Error('invalid_file_mode');
  const path=isNew?join(current.path,current.name):current.path;
  const body={operation:current.operation,confirmed:true,expected_version:isNew?'new':current.snapshot.version,...(isNew?{parent_version:current.snapshot.version}:current.operation==='rename'?{name:current.name}:current.operation==='chmod'?{mode:current.mode}:{})};
  try{checked(await fileApi<{machine_id:string}>('file-actions',path,{method:'POST',signal,body:JSON.stringify(body)}))}
  catch(e){
   if(!(e instanceof ApiError)||e.status>=500||e.message==='file_action_unverified'){
    if(alive.current)setMaintenance(value=>value?{...value,uncertain:true}:value);
    throw Error('file_action_unverified');
   }
   throw e;
  }
  if(alive.current&&!signal.aborted){setMaintenance(undefined);if(document?.path===current.path){setDocument(undefined);setContent('')}void message.success(t('操作已完成并核对','Operation completed and verified'))}
  await readDirectory(directory!.path,credential,signal);
  if(current.operation==='create'){
   const next=checked(await fileApi<Document>('file',path,{signal}));
   if(alive.current&&!signal.aborted){setDocument(next);setContent(next.content)}
  }
 });
 const actionTitle=maintenance?({create:t('新建文件','New file'),mkdir:t('新建目录','New directory'),rename:t('重命名','Rename'),remove:t('确认删除','Confirm deletion'),chmod:t('修改权限','Change permissions')})[maintenance.operation]:'';
 const crumbs=directory?.path.split('/').filter(Boolean)??[];
 return <Modal open title={t('文件管理','Files')+' · '+machine.name} width={1180} style={{top:24}} className="lm-host-resource-dialog lm-host-files-dialog" mask={{closable:false}} closable={!busy} keyboard={!busy} onCancel={()=>discard(()=>{void releaseSession();onClose()})} footer={null}>
  <div className="lm-host-file-account"><Typography.Text>{t('SSH 登录账户','SSH login account')}</Typography.Text><Select aria-label={t('文件管理 SSH 账户','File management SSH account')} value={credential} disabled={busy} placeholder={t('请选择有效的可复用凭据','Select an active reusable credential')} options={credentials.map(c=>({value:c.id,label:sshCredentialLabel(c)}))} onChange={key=>discard(()=>{setCredential(key);setDirectory(undefined);setDocument(undefined);setContent('');void guarded(async signal=>{await releaseSession();await readDirectory('/',key,signal)})})}/><Typography.Text type="secondary">{t('文件权限由此账户决定','File permissions follow this account')}</Typography.Text></div>
  {!busy&&!credentials.length&&<Alert showIcon type="info" title={t('请先为此主机配置有效的可复用 SSH 凭据','Configure an active reusable SSH credential for this host first')}/>}
  {error&&<Alert role="alert" showIcon type="error" title={error}/>}
  <div className="lm-host-file-toolbar"><Button aria-label={t('上级目录','Parent directory')} icon={<ArrowUpOutlined/>} disabled={busy||!directory||directory.path==='/'} onClick={()=>navigate(parent(directory!.path))}/><Input aria-label={t('目录路径','Directory path')} value={pathInput} disabled={busy||!credential} onChange={e=>setPathInput(e.target.value)} onPressEnter={()=>navigate(pathInput)} placeholder="/"/><Button aria-label={t('前往','Go')} disabled={busy||!credential} onClick={()=>navigate(pathInput)}>{t('前往','Go')}</Button><Button aria-label={t('刷新目录','Refresh directory')} icon={<ReloadOutlined/>} loading={busy} disabled={!credential} onClick={()=>void guarded(signal=>readDirectory(directory?.path??pathInput,credential,signal))}/><Button aria-label={t('新建文件','New file')} icon={<FileAddOutlined/>} disabled={busy||!directory} onClick={()=>prepareAction('create')}>{t('新建文件','New file')}</Button><Button aria-label={t('新建目录','New directory')} icon={<FolderAddOutlined/>} disabled={busy||!directory} onClick={()=>prepareAction('mkdir')}>{t('新建目录','New directory')}</Button><Button icon={<UploadOutlined/>} type="primary" disabled={busy||!directory} onClick={()=>discard(()=>{if(dirty){setDocument(undefined);setContent('')}fileInput.current?.click()})}>{t('上传文件','Upload file')}</Button><input aria-label={t('选择上传文件','Choose upload file')} ref={fileInput} type="file" hidden onChange={e=>{const file=e.target.files?.[0];e.target.value='';if(file)void selectUpload(file)}}/></div>
  {directory&&<Breadcrumb items={[{title:<Button type="link" size="small" disabled={busy} onClick={()=>navigate('/')}>/</Button>},...crumbs.map((name,i)=>({title:<Button size="small" type="link" disabled={busy} onClick={()=>navigate('/'+crumbs.slice(0,i+1).join('/'))}>{name}</Button>}))]}/>}
  {directory?.truncated&&<Alert type="warning" title={t('目录超过 2000 项，当前列表不完整','This directory exceeds 2,000 entries; the list is incomplete')}/>}
  <div className={'lm-host-file-layout'+(document?' lm-host-file-editing':'')}>
   <section className="lm-host-file-list"><Input.Search aria-label={t('筛选文件','Filter files')} placeholder={t('筛选当前目录','Filter this directory')} allowClear value={filter} onChange={e=>setFilter(e.target.value)}/><Typography.Paragraph className="lm-host-file-scroll-hint" type="secondary">{t('左右滑动查看权限和修改时间','Swipe sideways for permissions and modification time')}</Typography.Paragraph><Table<Entry> rowKey="name" size="small" loading={busy} pagination={{pageSize:10,showSizeChanger:true}} scroll={{x:document?540:700}} dataSource={(directory?.entries??[]).filter(entry=>entry.name.toLocaleLowerCase().includes(filter.toLocaleLowerCase()))} locale={{emptyText:directory?t('此目录没有匹配文件','No matching files in this directory'):t('打开目录后显示文件','Open a directory to view files')}} columns={[
    {title:t('名称','Name'),width:240,render:(_,entry)=><Button aria-label={entry.name} type="link" disabled={busy||!['directory','file'].includes(entry.type)} icon={entry.type==='directory'?<FolderOutlined/>:<FileOutlined/>} onClick={()=>entry.type==='directory'?navigate(join(directory!.path,entry.name)):openFile(entry)} className="lm-host-file-name">{entry.name}{entry.type==='symlink'?' ↗':''}</Button>},
    {title:t('大小','Size'),width:90,render:(_,entry)=>entry.type==='directory'?'—':size(entry.size)},
    {title:t('权限','Mode'),dataIndex:'mode',width:70},
    {title:t('修改时间','Modified'),dataIndex:'modified_at',width:180,render:v=>new Date(v).toLocaleString(language)},
    {title:t('操作','Actions'),width:65,fixed:'right',render:(_,entry)=><Dropdown trigger={['click']} menu={{items:[{key:'rename',label:t('重命名','Rename')},{key:'chmod',label:t('修改权限','Change permissions')},{key:'remove',label:t('删除','Delete'),danger:true}],onClick:({key})=>prepareAction(key as Maintenance['operation'],entry)}} disabled={busy||!['file','directory'].includes(entry.type)}><Button type="text" icon={<MoreOutlined/>} aria-label={t('文件操作','File actions')+' '+entry.name} disabled={busy||!['file','directory'].includes(entry.type)}/></Dropdown>}
   ]}/></section>
   {document&&<section className="lm-host-file-editor" aria-label={t('文件编辑器','File editor')}><div className="lm-host-editor-heading"><Typography.Text code copyable style={{overflowWrap:'anywhere'}}>{document.path}</Typography.Text>{dirty&&<Tag color="warning">{t('未保存','Unsaved')}</Tag>}</div><Suspense fallback={<div className="lm-code-editor-loading" role="status" aria-live="polite"><Spin size="small"/> {t('正在加载编辑器…','Loading editor…')}</div>}><CodeEditor ariaLabel={t('文件内容','File contents')} filename={document.path} value={content} disabled={busy} onChange={setContent} height={340} onSave={()=>{if(dirty&&!busy)save()}}/></Suspense><Space wrap><Button aria-label={t('保存文件','Save file')} type="primary" icon={<SaveOutlined/>} loading={busy} disabled={!dirty||busy} onClick={save}>{t('保存文件','Save file')}</Button><Button disabled={busy} onClick={()=>discard(()=>{setDocument(undefined);setContent('')})}>{t('关闭文件','Close file')}</Button><Typography.Text type="secondary">{t('UTF-8 · 最大 1 MiB','UTF-8 · Up to 1 MiB')}</Typography.Text></Space></section>}
  </div>
  <Modal open={!!upload} title={upload?.version?t('确认覆盖文件','Confirm file overwrite'):t('确认上传文件','Confirm file upload')} onCancel={()=>{if(!busy)setUpload(undefined)}} closable={!busy} mask={{closable:false}} keyboard={!busy} okText={upload?.version?t('覆盖并上传','Overwrite and upload'):t('上传','Upload')} cancelText={t('取消','Cancel')} onOk={sendUpload} confirmLoading={busy} okButtonProps={{'aria-label':upload?.version?t('覆盖并上传','Overwrite and upload'):t('上传','Upload'),danger:!!upload?.version,disabled:busy}} cancelButtonProps={{'aria-label':t('取消','Cancel'),disabled:busy}}><Typography.Paragraph style={{overflowWrap:'anywhere'}}>{upload?.path}</Typography.Paragraph><Typography.Paragraph>{upload&&size(upload.file.size)}</Typography.Paragraph>{upload?.version&&<Alert type="warning" showIcon title={t('同名文件已存在，将替换其内容','A file with this name exists. Its contents will be replaced.')}/ >}{error&&<Alert type="error" title={error}/>}</Modal>
  <Modal open={!!maintenance} title={actionTitle} onCancel={()=>{if(!busy)setMaintenance(undefined)}} closable={!busy} mask={{closable:false}} keyboard={!busy} okText={maintenance?.operation==='remove'?t('删除','Delete'):t('确认','Confirm')} cancelText={t('取消','Cancel')} onOk={confirmAction} confirmLoading={busy} okButtonProps={{'aria-label':maintenance?.operation==='remove'?t('删除','Delete'):t('确认','Confirm'),danger:maintenance?.operation==='remove',disabled:busy||maintenance?.uncertain}} cancelButtonProps={{'aria-label':t('取消','Cancel'),disabled:busy}}>
   <Typography.Paragraph className="lm-host-maintenance-path">{maintenance?.path}</Typography.Paragraph>
   {maintenance&&['create','mkdir','rename'].includes(maintenance.operation)&&<label className="lm-host-maintenance-field">{t('名称','Name')}<Input aria-label={t('名称','Name')} autoFocus value={maintenance.name} disabled={busy||maintenance.uncertain} maxLength={255} onChange={e=>setMaintenance({...maintenance,name:e.target.value})} onPressEnter={()=>{if(!busy)confirmAction()}}/></label>}
   {maintenance?.operation==='chmod'&&<label className="lm-host-maintenance-field">{t('八进制权限','Octal permissions')}<Input aria-label={t('八进制权限','Octal permissions')} autoFocus value={maintenance.mode} disabled={busy||maintenance.uncertain} maxLength={4} placeholder="0644" onChange={e=>setMaintenance({...maintenance,mode:e.target.value})}/><Typography.Text type="secondary">{t('范围 0000—0777，仅修改当前文件或目录。','Range 0000–0777. Applies only to this file or directory.')}</Typography.Text></label>}
   {maintenance?.operation==='remove'&&<Alert type="warning" showIcon title={t('删除后不可撤销','Deletion cannot be undone')} description={maintenance.snapshot.type==='directory'?t('仅删除这个空目录，不递归删除内容。','Removes this empty directory only; contents are never removed recursively.'):t('仅删除以上文件。','Removes only the file shown above.')}/>}
   {error&&<Alert role="alert" type={maintenance?.uncertain?'warning':'error'} showIcon title={error}/>}
  </Modal>
 </Modal>;
}
