// Loopback-only UI fixture: synthetic host receipts, no SSH or Docker access.
import {createServer} from 'node:http';
import {mkdir,mkdtemp,readFile,writeFile,rm,stat} from 'node:fs/promises';
import {extname,join,resolve} from 'node:path';
import {build} from 'vite';

const web=resolve(import.meta.dirname,'../../..'),repo=resolve(web,'..');
const source=await mkdtemp(join(web,'.docker-existing-ui-'));
const output=join(repo,'.local-dev/docker-existing-environment-082/ui');
await mkdir(output,{recursive:true});
await writeFile(join(source,'index.html'),'<div id="root"></div><script type="module" src="./main.tsx"></script>');
await writeFile(join(source,'main.tsx'),`
import React,{useState} from 'react';import{createRoot}from'react-dom/client';import{BrowserRouter}from'react-router-dom';
import{App,ConfigProvider}from'../src/shared/ui';import{I18nProvider}from'../src/shared/i18n';import Panel from'../src/app/ops/DockerEnvironmentPanel';import'../src/app/style.css';
const query=new URLSearchParams(location.search);localStorage.setItem('lightmoni.language',query.get('language')==='en-US'?'en-US':'zh-CN');
function Harness(){const[open,setOpen]=useState(true);return <><h1>Docker environment QA (synthetic)</h1><Panel machine={open?{id:'qa-'+(query.get('scenario')||'unknown'),name:'Synthetic host'}:undefined} onClose={()=>setOpen(false)}/></>}
createRoot(document.getElementById('root')!).render(<I18nProvider><BrowserRouter><ConfigProvider><App><Harness/></App></ConfigProvider></BrowserRouter></I18nProvider>);
`);
try {
 await build({root:source,configFile:false,base:'/',logLevel:'silent',build:{outDir:output,emptyOutDir:true},resolve:{dedupe:['react','react-dom']}});
} finally {await rm(source,{recursive:true,force:true});}

const calls=[],installed=new Set();
const server=createServer(async(req,res)=>{
 try {
  const url=new URL(req.url,'http://fixture'),path=url.pathname;
  const json=(value,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
  if(path==='/__qa/calls')return json(calls);
  if(path.startsWith('/api/')){
   const parts=path.split('/'),id=parts[4],scenario=id?.replace(/^qa-/,'');
   const environment=scenario==='ready'?{state:'ready',code:'',source:'executor',observed_at:new Date().toISOString()}:{state:'unknown',code:'executor_observation_required',source:'none',observed_at:''};
   const machine={id,name:'Synthetic host',agent_id:'qa-agent',docker_environment:environment};
   if(req.method==='GET'&&path.endsWith('/docker-environment'))return json({machine,installation:installed.has(id)||scenario==='verified'?{id:'qa-installation',state:'succeeded',phase:'verified',code:'',updated_at:new Date().toISOString()}:scenario==='unsupported'?{id:'qa-installation',state:'failed',phase:'checking_system',code:'docker_install_unsupported',updated_at:new Date().toISOString()}:undefined});
   if(req.method==='GET'&&parts.length===5)return json({machine,credentials:[{id:'qa-credential',name:'Synthetic SSH credential',method:'ssh_key',retention:'permanent',is_default:true}]});
   if(req.method==='POST'&&path.endsWith('/docker-installations')){
    let body='';for await(const chunk of req)body+=chunk;const value=JSON.parse(body);calls.push({path,body:value});
    if(value.confirmed!==true||value.credential_id!=='qa-credential')return json({error:'invalid_fixture_request'},400);
    installed.add(id);return json({id:'qa-installation',state:'succeeded',phase:'verified',code:'',updated_at:new Date().toISOString()},202);
   }
   calls.push({unexpected:path,method:req.method});return json({error:'unexpected_fixture_request'},404);
  }
  let file=resolve(output,decodeURIComponent(path).replace(/^\//,''));
  if(!file.startsWith(output+'/'))file=join(output,'index.html');
  try{if(!(await stat(file)).isFile())file=join(output,'index.html');}catch{file=join(output,'index.html');}
  res.setHeader('content-type',({'.html':'text/html','.js':'text/javascript','.css':'text/css'}[extname(file)]||'application/octet-stream'));
  res.end(await readFile(file));
 } catch {res.writeHead(500);res.end('fixture_error');}
});
await new Promise(resolve=>server.listen(19882,'127.0.0.1',resolve));
console.log('Docker environment UI fixture: http://127.0.0.1:19882/');
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{server.closeAllConnections();server.close(()=>process.exit(0));});
