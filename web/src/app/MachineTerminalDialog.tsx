import {useCallback,useEffect,useRef,useState} from 'react';
import {Terminal} from '@xterm/xterm';
import {FitAddon} from '@xterm/addon-fit';
import {FullscreenOutlined,FullscreenExitOutlined,DisconnectOutlined,ReloadOutlined} from '@ant-design/icons';
import {Alert,Button,Modal,Select,Space,Tag,Typography} from '../shared/ui';
import {api} from '../shared/api';
import {useI18n} from '../shared/i18n';
import '@xterm/xterm/css/xterm.css';
import './machine-terminal.css';

type Host={id:string;name:string;address:string;port:number;username:string};
type Key={id:string;method:string;secret_fingerprint:string;expires_at:string;revoked_at?:string};
type Entry={id:string;websocket_path:string};
type State='idle'|'creating'|'connecting'|'connected'|'closed'|'error';
const sessionPath=(hostID:string,id:string)=>`/machines/${encodeURIComponent(hostID)}/terminal-sessions/${encodeURIComponent(id)}`;

export default function MachineTerminalDialog({machine,credentials,onClose}:{machine:Host;credentials:Key[];onClose:()=>void}){
 const {t}=useI18n(),[full,setFull]=useState(false);
 return <Modal open title={t(`SSH 终端 · ${machine.name}`,`SSH terminal · ${machine.name}`)} onCancel={onClose} footer={null} width={full?'calc(100vw - 32px)':1040} style={{top:full?16:48}} className={`lm-terminal-dialog${full?' lm-terminal-full':''}`} destroyOnHidden maskClosable={false}>
  <TerminalPanel machine={machine} credentials={credentials} full={full} toggleFull={()=>setFull(v=>!v)}/>
 </Modal>;
}
function TerminalPanel({machine,credentials,full,toggleFull}:{machine:Host;credentials:Key[];full:boolean;toggleFull:()=>void}){
 const {t}=useI18n();
 const keys=credentials.filter(c=>c.method==='ssh_key'&&!c.revoked_at&&Date.parse(c.expires_at)>Date.now());
 const [credential,setCredential]=useState<string|undefined>(keys.length===1?keys[0].id:undefined);
 const [state,setState]=useState<State>('idle'),[reason,setReason]=useState(''),[error,setError]=useState('');
 const host=useRef<HTMLDivElement>(null),terminal=useRef<Terminal|null>(null),socket=useRef<WebSocket|null>(null);
 const connected=useRef(false);
 const entry=useRef<Entry|null>(null),generation=useRef(0),alive=useRef(false);
 const stop=useCallback(async()=>{
  generation.current++;connected.current=false;
  const ws=socket.current;socket.current=null;ws?.close();
  const pending=entry.current;entry.current=null;
  if(pending)await api(sessionPath(machine.id,pending.id),{method:'DELETE',keepalive:true}).catch(()=>{});
 },[machine.id]);
 const start=useCallback(async(keyID?:string)=>{
  const cleanup=stop(),run=generation.current;
  setState('creating');setReason('');setError('');
  await cleanup;
  if(!alive.current||generation.current!==run)return;
  terminal.current?.reset();
  try{
   const term=terminal.current;
   const result=await api<Entry>(`/machines/${encodeURIComponent(machine.id)}/terminal-sessions`,{method:'POST',body:JSON.stringify({credential_id:keyID,cols:Math.min(500,term?.cols??100),rows:Math.min(200,term?.rows??30)}),keepalive:true});
   if(!alive.current||generation.current!==run){void api(sessionPath(machine.id,result.id),{method:'DELETE',keepalive:true}).catch(()=>{});return;}
   entry.current=result;
   const url=new URL(result.websocket_path,window.location.href);url.protocol=location.protocol==='https:'?'wss:':'ws:';
   const ws=new WebSocket(url);ws.binaryType='arraybuffer';socket.current=ws;setState('connecting');
   const current=()=>alive.current&&generation.current===run&&socket.current===ws;
   let ended=false;
   ws.onmessage=event=>{
    if(!current())return;
    if(event.data instanceof ArrayBuffer){
     const data=new Uint8Array(event.data);
     terminal.current?.write(data,()=>{if(current()&&ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:'ack',bytes:data.byteLength}));});
    }else{
     try{
      const message=JSON.parse(event.data);
      if(message.type==='status'){
       setState(message.status);setReason(message.reason??'');connected.current=message.status==='connected';
       if(message.status==='connected'){
        terminal.current?.focus();
        ws.send(JSON.stringify({type:'resize',cols:Math.min(500,terminal.current?.cols??100),rows:Math.min(200,terminal.current?.rows??30)}));
       }
       if(message.status==='closed')ended=true;
      }else if(message.type==='error'){ended=true;setState('error');setReason(message.code);}
     }catch{ended=true;setState('error');setReason('invalid_response');ws.close();}
    }
   };
   ws.onerror=()=>{if(current()&&!ended){ended=true;setState('error');setReason('connection_lost');}};
   ws.onclose=()=>{if(!current())return;connected.current=false;if(entry.current?.id===result.id){entry.current=null;void api(sessionPath(machine.id,result.id),{method:'DELETE',keepalive:true}).catch(()=>{});}if(!ended){setState('closed');setReason('connection_lost');}};
  }catch(e){if(alive.current&&generation.current===run){setState('error');setError(e instanceof Error?e.message:'Connection failed');}}
 },[machine.id,stop]);
 useEffect(()=>{
  alive.current=true;
  const term=new Terminal({cursorBlink:true,fontFamily:'Menlo, Monaco, Consolas, monospace',fontSize:13,scrollback:3000,theme:{background:'#111827',foreground:'#e5e7eb',cursor:'#e5e7eb',selectionBackground:'#374151'}});
  const fit=new FitAddon();term.loadAddon(fit);term.open(host.current!);terminal.current=term;
  const fitWindow=()=>{if(host.current?.clientWidth&&host.current.clientHeight){fit.fit();if(term.cols>500||term.rows>200)term.resize(Math.min(term.cols,500),Math.min(term.rows,200));}};
  const observer=new ResizeObserver(fitWindow);observer.observe(host.current!);fitWindow();
  const input=term.onData(data=>{
   const ws=socket.current;if(!connected.current||ws?.readyState!==WebSocket.OPEN)return;
   // Unicode-aware slices keep each JSON input frame within the byte limit.
   for(const part of data.match(/[\s\S]{1,4096}/gu)??[]){
    if(ws.bufferedAmount>64*1024){void stop();setState('error');setReason('input_overflow');return;}
    ws.send(JSON.stringify({type:'input',data:part}));
   }
  });
  const resize=term.onResize(({cols,rows})=>{const ws=socket.current;if(ws?.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:'resize',cols:Math.min(500,cols),rows:Math.min(200,rows)}));});
  const leave=()=>{void stop()};window.addEventListener('pagehide',leave);
  if(keys.length===1)void start(keys[0].id);
  return()=>{alive.current=false;void stop();window.removeEventListener('pagehide',leave);observer.disconnect();input.dispose();resize.dispose();terminal.current=null;term.dispose();};
  // A mounted panel belongs to one host. Credential changes require a reconnect.
 },[machine.id,start,stop]);
 const busy=['creating','connecting','connected'].includes(state);
 const explanations:Record<string,string>={
  host_key_mismatch:t('主机指纹不匹配，请在主机管理中核实。','Host fingerprint mismatch. Verify the registered host.'),
  authentication_failed:t('私钥认证失败，请检查用户名和私钥。','Private-key authentication failed. Check the username and key.'),
  invalid_private_key:t('私钥无法使用；目前仅支持无口令的 SSH 私钥。','The key cannot be used. Only SSH keys without a passphrase are supported.'),
  credential_invalid:t('凭据已撤销、过期或主机连接已变更。','The credential was revoked or expired, or the host changed.'),
  login_expired:t('登录已失效或管理员权限已变更，请重新登录。','Your login expired or administrator access changed. Sign in again.'),
  connect_expired:t('连接入口已过期，请重新连接。','The connection entry expired. Reconnect.'),
  connect_timeout:t('SSH 连接超时，请检查地址、端口和网络。','SSH connection timed out. Check the address, port, and network.'),
  connection_lost:t('终端连接已中断，请检查网络、登录状态或反向代理的 WebSocket 配置后重试。','Connection lost. Check your network, login, and reverse proxy WebSocket support, then reconnect.'),
  remote_closed:t('远端会话已结束。','The remote session ended.'),
  disconnected:t('已主动断开连接。','Disconnected.'),
  idle_timeout:t('10 分钟未输入，连接已关闭。','Disconnected after 10 minutes without input.'),
  session_limit:t('已达到 30 分钟会话上限，请重新连接。','The 30-minute session limit was reached. Reconnect.'),
  server_shutdown:t('平台已停止，终端连接已关闭。','The platform stopped and closed the terminal.'),
  ssh_failed:t('SSH 连接失败，请检查主机和私钥。','SSH connection failed. Check the host and private key.'),
  pty_failed:t('远端未能创建交互终端，请检查 SSH 账户是否允许 PTY 和 shell。','The remote host could not open a terminal. Check that PTY and shell access are allowed.'),
  output_overflow:t('输出超出缓冲上限，连接已关闭。','Output exceeded the buffer limit. The connection was closed.'),
  input_overflow:t('输入过快，连接已关闭，请重新连接。','Input exceeded the buffer limit. Reconnect.'),
  invalid_message:t('终端通信异常，请重新连接。','Terminal protocol error. Reconnect.'),
  invalid_response:t('终端响应异常，请重新连接。','Invalid terminal response. Reconnect.'),
 };
 const labels:Record<State,string>={idle:t('待连接','Ready'),creating:t('正在准备','Preparing'),connecting:t('正在连接','Connecting'),connected:t('已连接','Connected'),closed:t('已断开','Disconnected'),error:t('连接失败','Connection failed')};
 return <div className="lm-terminal-panel">
  <div className="lm-terminal-toolbar"><Space wrap><Tag color={state==='connected'?'success':state==='error'?'error':busy?'processing':'default'} role="status">{labels[state]}</Tag><Typography.Text code>{machine.username}@{machine.address}:{machine.port}</Typography.Text></Space><Space><Button aria-label={t('全屏切换','Toggle fullscreen')} icon={full?<FullscreenExitOutlined/>:<FullscreenOutlined/>} onClick={toggleFull}>{full?t('退出全屏','Exit fullscreen'):t('全屏','Fullscreen')}</Button>{busy?<Button aria-label={t('断开','Disconnect')} icon={<DisconnectOutlined/>} onClick={()=>{void stop();setState('closed');setReason('disconnected')}}>{t('断开','Disconnect')}</Button>:<Button aria-label={state==='idle'?t('连接','Connect'):t('重新连接','Reconnect')} type="primary" icon={<ReloadOutlined/>} disabled={!credential} onClick={()=>void start(credential)}>{state==='idle'?t('连接','Connect'):t('重新连接','Reconnect')}</Button>}</Space></div>
  {keys.length!==1&&<div className="lm-terminal-key"><span>{t('SSH 私钥','SSH private key')}</span><Select aria-label={t('终端 SSH 私钥','Terminal SSH private key')} value={credential} onChange={setCredential} disabled={busy} placeholder={t('请选择有效私钥','Select an active private key')} options={keys.map(k=>({value:k.id,label:k.secret_fingerprint||k.id}))}/></div>}
  {!keys.length&&<Alert type="warning" showIcon title={t('请先添加有效的无口令 SSH 私钥。密码凭据暂不支持交互终端。','Add an active SSH key without a passphrase. Password credentials do not support the terminal yet.')}/>}
  {(error||reason)&&<Alert type={state==='error'||!['remote_closed','disconnected'].includes(reason)?'warning':'info'} showIcon title={error||explanations[reason]||t('连接已关闭，请重新连接。','Connection closed. Reconnect.')}/>}
  <div className="lm-terminal-screen" ref={host} aria-label={t('交互式 SSH 终端','Interactive SSH terminal')}/>
  <Typography.Text type="secondary" className="lm-terminal-hint">{t('命令将直接在目标主机执行。关闭窗口会断开连接；10 分钟无输入或 30 分钟后自动断开。平台不保存终端输入与输出。','Commands run directly on the host. Closing this window disconnects SSH. Sessions close after 10 minutes without input or 30 minutes in total. Terminal input and output are not stored by the platform.')}</Typography.Text>
 </div>;
}
