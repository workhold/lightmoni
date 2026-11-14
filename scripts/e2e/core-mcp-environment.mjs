import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:https";
import { createServer as createTcpServer } from "node:net";
import { createReadStream, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";

const root=resolve(new URL("../..",import.meta.url).pathname),work=process.env.LIGHTMONI_CORE_E2E_DIR??"/tmp/lightmoni-core-e2e";
const stateFile=join(work,"state.json"),secretsFile=join(work,"secrets.json");
const read=(file,fallback={})=>existsSync(file)?JSON.parse(readFileSync(file,"utf8")):fallback;
let state=read(stateFile),secrets=read(secretsFile);
const save=()=>{mkdirSync(work,{recursive:true,mode:0o700});writeFileSync(stateFile,JSON.stringify(state,null,2),{mode:0o600});writeFileSync(secretsFile,JSON.stringify(secrets,null,2),{mode:0o600});};
const run=(command,args,options={})=>execFileSync(command,args,{stdio:"inherit",...options});
const quiet=(command,args,options={})=>execFileSync(command,args,{encoding:"utf8",...options}).trim();
const secret=()=>randomBytes(32).toString("base64url");
const freePort=async()=>{const server=createTcpServer();await new Promise(r=>server.listen(0,"127.0.0.1",r));const port=server.address().port;await new Promise(r=>server.close(r));return port;};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const api=async(path,method="GET",body,admin=false)=>{
 const headers={"content-type":"application/json"};
 if(admin){headers.cookie=secrets.cookie;headers.origin=state.externalURL;}
 const response=await fetch(state.centerURL+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
 const text=await response.text();let data;try{data=text?JSON.parse(text):{};}catch{data={raw:text};}
 if(!response.ok)throw Error(`${method} ${path}: ${response.status} ${text.slice(0,500)}`);return{status:response.status,data,headers:response.headers};
};
const wait=async(fn,timeout=90_000)=>{const start=Date.now();for(;;){try{const value=await fn();if(value)return value;}catch{}if(Date.now()-start>timeout)throw Error("environment wait timed out");await sleep(1000);}};
const cleanup=async()=>{
 try{for(const line of quiet("ps",["eww","-ax","-o","pid,command"]).split("\n")){if(state.dataDir&&line.includes("LIGHTMONI_DATA="+state.dataDir)||state.suffix&&line.includes("LIGHTMONI_CORE_E2E_ID="+state.suffix)){const pid=Number(line.trim().split(/\s+/)[0]);if(pid)try{process.kill(pid,"SIGKILL");}catch{}}}}catch{}
 for(const name of [state.agentContainer,state.chContainer])if(name)try{run("docker",["rm","-f",name]);}catch{}
 for(const pid of [state.centerPID,state.proxyPID,state.sshPID])if(pid)try{process.kill(-pid,"SIGKILL");}catch{try{process.kill(pid,"SIGKILL");}catch{}}
 for(const file of [secretsFile,join(work,"bootstrap.json"),join(work,"agent-config.json"),join(work,"ca.key"),join(work,"server.key"),join(work,"server.csr"),join(work,"ch.env")])try{rmSync(file,{force:true});}catch{}
 state={};secrets={};writeFileSync(stateFile,"{}\n",{mode:0o600});try{rmSync(secretsFile,{force:true});}catch{}
};
const setup=async()=>{
 if(existsSync(stateFile))await cleanup();rmSync(join(work,"data"),{recursive:true,force:true});mkdirSync(work,{recursive:true,mode:0o700});
 const suffix=randomBytes(4).toString("hex"),arch=process.arch==="arm64"?"arm64":"amd64";
 state={suffix,arch,baseCommit:quiet("git",["rev-parse","HEAD"],{cwd:root}),dataDir:join(work,"data"),dbPath:join(work,"data","lightmoni.db"),chContainer:"lightmoni-core-e2e-ch-"+suffix,agentContainer:"lightmoni-core-e2e-agent-"+suffix,
  centerPort:await freePort(),proxyPort:await freePort(),chPort:await freePort(),created_at:new Date().toISOString()};
 state.centerURL=`http://127.0.0.1:${state.centerPort}`;state.externalURL=`https://localhost:${state.proxyPort}`;save();
 const chPassword=secret();writeFileSync(join(work,"ch.env"),`CLICKHOUSE_USER=lightmoni\nCLICKHOUSE_PASSWORD=${chPassword}\nCLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1\n`,{mode:0o600});secrets.chPassword=chPassword;save();
 run("docker",["run","-d","--name",state.chContainer,"--env-file",join(work,"ch.env"),"-p",`127.0.0.1:${state.chPort}:8123`,"docker.1ms.run/clickhouse/clickhouse-server:26.8"]);
 await wait(async()=>{const response=await fetch(`http://127.0.0.1:${state.chPort}/?query=SELECT%201`,{headers:{authorization:"Basic "+Buffer.from(`lightmoni:${chPassword}`).toString("base64")}});return response.ok;},180_000);
 run("openssl",["req","-x509","-newkey","rsa:2048","-nodes","-keyout",join(work,"ca.key"),"-out",join(work,"ca.crt"),"-subj","/CN=LightMoni Core E2E CA","-days","1"]);
 run("openssl",["req","-newkey","rsa:2048","-nodes","-keyout",join(work,"server.key"),"-out",join(work,"server.csr"),"-subj","/CN=localhost"]);
 writeFileSync(join(work,"san.cnf"),"subjectAltName=DNS:localhost,IP:127.0.0.1\n");run("openssl",["x509","-req","-in",join(work,"server.csr"),"-CA",join(work,"ca.crt"),"-CAkey",join(work,"ca.key"),"-CAcreateserial","-out",join(work,"server.crt"),"-days","1","-extfile",join(work,"san.cnf")]);
 run("npm",["run","build"],{cwd:root});
 const centerLog=openSync(join(work,"center.log"),"a");const center=spawn(process.execPath,["runtime/dist/server/main.js"],{cwd:root,detached:true,stdio:["ignore",centerLog,centerLog],env:{...process.env,LIGHTMONI_CORE_E2E_ID:suffix,LIGHTMONI_ADDR:`127.0.0.1:${state.centerPort}`,LIGHTMONI_DATA:state.dataDir,LIGHTMONI_CH_URL:`http://127.0.0.1:${state.chPort}`,LIGHTMONI_CH_USER:"lightmoni",LIGHTMONI_CH_PASSWORD:chPassword,LIGHTMONI_EXTERNAL_URL:state.externalURL}});state.centerPID=center.pid;center.unref();
 const proxyLog=openSync(join(work,"proxy.log"),"a");const proxy=spawn(process.execPath,["-e",`const h=require('node:https'),f=require('node:fs'),http=require('node:http');h.createServer({key:f.readFileSync(process.argv[1]),cert:f.readFileSync(process.argv[2])},(q,r)=>{const p=http.request({host:'127.0.0.1',port:Number(process.argv[3]),path:q.url,method:q.method,headers:q.headers},u=>{r.writeHead(u.statusCode,u.headers);u.pipe(r)});p.on('error',e=>{r.statusCode=502;r.end()});q.pipe(p)}).listen(Number(process.argv[4]),'127.0.0.1')`,join(work,"server.key"),join(work,"server.crt"),String(state.centerPort),String(state.proxyPort)],{detached:true,stdio:["ignore",proxyLog,proxyLog],env:{...process.env,LIGHTMONI_CORE_E2E_ID:suffix}});state.proxyPID=proxy.pid;proxy.unref();save();
 await wait(async()=>{const response=await fetch(state.centerURL+"/healthz");return response.ok;},120_000);
 const adminPassword=secret(),setup=await api("/api/v1/setup","POST",{name:"admin",password:adminPassword});state.adminID=setup.data.id;secrets.adminPassword=adminPassword;secrets.cookie=(setup.headers.getSetCookie?setup.headers.getSetCookie():[setup.headers.get("set-cookie")]).join(";").split(";")[0];save();
 const scopes=["hosts.read","tasks.read","tasks.source.read","tasks.propose","proposals.read","executions.read","telemetry.catalog.read","telemetry.query","alerts.read","alerts.detail.read","logs.read","traces.read","deployments.read","deployments.propose","operations.read","operations.propose","agents.read","agents.maintain.propose","dashboards.read","dashboards.detail.read","code.workspace.read","code.workspace.detail.read","code.workspace.propose","alerts.incidents.read","alerts.notifications.read","alerts.statistics.read","alerts.propose"];
 const pat=await api("/api/v1/mcp-access/tokens","POST",{name:"Core E2E Codex",scopes,host_ids:null,expires_in_hours:2},true);secrets.pat=pat.data.token;state.grantID=pat.data.grant_id;
 const restricted=await api("/api/v1/mcp-access/tokens","POST",{name:"Core E2E restricted",scopes:["hosts.read"],host_ids:[],expires_in_hours:2},true);secrets.restrictedPat=restricted.data.token;state.restrictedGrantID=restricted.data.grant_id;
 const sdkKey=await api("/api/v1/keys","POST",{name:"Core E2E SDK"},true);secrets.sdkKey=sdkKey.data.key;save();
 const machine=await api("/api/v1/machines","POST",{name:"Core E2E isolated host",address:"127.0.0.1",port:22,connection_method:"direct_ssh"},true);state.machineID=machine.data.id;save();
 run(process.execPath,["scripts/e2e/core-mcp-native-setup.mjs","setup"],{cwd:root,env:{...process.env,CORE_E2E_STATE_FILE:stateFile,CORE_E2E_SECRETS_FILE:secretsFile}});state=read(stateFile);secrets=read(secretsFile);
 run(process.execPath,["scripts/e2e/core-mcp-agent.mjs"],{cwd:root,env:process.env});state=read(stateFile);secrets=read(secretsFile);
 run(process.execPath,["scripts/e2e/core-mcp-ssh.mjs"],{cwd:root,env:process.env});state=read(stateFile);secrets=read(secretsFile);
 const marker="CORE_E2E_TASK_SUCCESS_"+suffix,task=await api("/api/v1/agent-tasks","POST",{name:"Core E2E task "+suffix,type:"script",enabled:true,target_all:false,host_ids:[state.machineID],label_ids:[],schedule:{mode:"once"},script:{runtime:"node",code:`console.log('${marker}')`,timeout_seconds:10,max_output_bytes:4096}},true);state.taskID=task.data.id;state.marker=marker;save();
 run(process.execPath,["examples/sdk/node/index.mjs"],{cwd:root,env:{...process.env,LIGHTMONI_ENDPOINT:state.centerURL,LIGHTMONI_KEY:secrets.sdkKey,LIGHTMONI_SERVICE:"core-e2e-service",LIGHTMONI_COUNT:"3",LIGHTMONI_SELF_TELEMETRY:"false"}});
 state.ready_at=new Date().toISOString();save();console.log(JSON.stringify({ready:true,work,centerURL:state.centerURL,externalURL:state.externalURL,machine_id:state.machineID,task_id:state.taskID,agent_id:state.agentID,executor_id:state.executorID}));
};
if(process.argv[2]==="setup")await setup();else if(process.argv[2]==="cleanup")await cleanup();else if(process.argv[2]==="status")console.log(JSON.stringify(state,null,2));else if(process.argv[2]==="api"){
 const result=await api(process.argv[3],process.argv[4]??"GET",process.argv[5]?JSON.parse(readFileSync(process.argv[5],"utf8")):undefined,true);console.log(JSON.stringify(result.data));
}else throw Error("usage: setup|cleanup|status|api");
