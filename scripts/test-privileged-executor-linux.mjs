#!/usr/bin/env node
/** Opt-in integration harness for a NEW, DISPOSABLE local systemd Docker container.
 * Never run on a user/production machine. Required fixture layout and commands:
 * specs/060-privileged-executor/linux-validation.md. All keys, enrollment and
 * identities are generated in memory for a localhost HTTPS test center.
 */
import {createServer} from 'node:https';
import {once} from 'node:events';
import {readFileSync,writeFileSync,mkdirSync,existsSync,cpSync} from 'node:fs';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {spawn,execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {DB} from '/opt/lightmoni/runtime/dist/shared/sqlite.js';
import {Router,fail} from '/opt/lightmoni/runtime/dist/shared/http.js';
import {cipher} from '/opt/lightmoni/runtime/dist/shared/crypto.js';
import {registerTaskCenter} from '/opt/lightmoni/runtime/dist/server/task-center.js';
import {registerPrivilegedExecutors} from '/opt/lightmoni/runtime/dist/server/privileged-executors.js';
import {executorProgramApplyCommand,executorProgramProbeCommand,executorProgramStatusCommand} from '/opt/lightmoni/runtime/dist/server/machine-executor-maintenance.js';
import {DatabaseSync} from 'node:sqlite';

if(process.platform!=='linux'||process.getuid?.()!==0||!existsSync('/.dockerenv')||!process.argv.includes('--isolated-systemd-container'))throw Error('explicit_disposable_linux_container_required');
if(!existsSync('/usr/bin/curl'))throw Error('disposable_fixture_requires_curl');
if(existsSync('/etc/lightmoni-executor/config.json')||existsSync('/var/lib/lightmoni-executor/journal.sqlite'))throw Error('fresh_container_required_do_not_overwrite_state');
const dockerImage=process.env.LIGHTMONI_QA_DOCKER_IMAGE||'';
if(dockerImage&&!/^[a-z0-9][a-z0-9./:_-]+@sha256:[a-f0-9]{64}$/.test(dockerImage))throw Error('digest_pinned_test_image_required');
const enabled=dockerImage?['script.elevated.v1','container.managed.v1']:['script.elevated.v1'];
const dir='/run/lm060',db=new DB(':memory:'),router=new Router(),crypt=cipher(randomBytes(32));
const user={id:'test-admin',name:'Test admin',role:'admin'};
const deps={db,router,now:()=>new Date(),externalURL:'https://localhost:19443',...crypt,
auth:{user:()=>user,requireAdmin(c){if(c.user.role!=='admin')fail(403,'denied')}},logger:{info(){},warn(){},error(){}}};
router.auth=deps.auth;
const tasks=registerTaskCenter(deps);
db.exec('CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT,role TEXT,active INTEGER)');
db.run("INSERT INTO users VALUES('test-admin','Test admin','admin',1)");
db.run("INSERT INTO managed_machines(id,name,address,port,username,connection_method,agent_id,created_at,updated_at) VALUES('qa-host','QA','localhost',22,'root','direct_ssh','qa-agent',?,?)",new Date().toISOString(),new Date().toISOString());
const store=registerPrivilegedExecutors(deps,{dataDir:'/run/lm060'});
// Disposable fixture artifacts only: no production URL, token or release is used.
const maintenanceArchives=new Map();
router.get('/downloads/executor-maintenance/:operation/bundle.tar.gz',c=>{
  const artifact=maintenanceArchives.get(c.params.operation);
  if(!artifact||c.req.headers.authorization!=='Bearer qa-maintenance-ticket')fail(403,'fixture_download_denied');
  c.res.writeHead(200,{'Content-Type':'application/gzip'});c.res.end(readFileSync(artifact));
},{public:true});
const server=createServer({key:readFileSync(dir+'/tls.key'),cert:readFileSync(dir+'/tls.crt')},(req,res)=>void router.handle(req,res));
server.listen(19443,'127.0.0.1');await once(server,'listening');
const wait=async(fn,ms=30000)=>{const end=Date.now()+ms;while(Date.now()<end){const v=fn();if(v)return v;await new Promise(r=>setTimeout(r,200));}throw Error('timeout')};
const child=async(cmd,args,stdin,env={})=>await new Promise((resolve,reject)=>{
const p=spawn(cmd,args,{env:{PATH:'/usr/sbin:/usr/bin:/sbin:/bin',NODE_EXTRA_CA_CERTS:dir+'/tls.crt',...env},stdio:['pipe','pipe','pipe']});let out='',err='';
p.stdout.on('data',v=>out+=v);p.stderr.on('data',v=>err+=v);p.stdin.end(stdin||'');p.on('error',reject);p.on('exit',code=>code===0?resolve(out):reject(Error(cmd+' failed ('+code+'): '+err.slice(-2000))));});
const report={environment:'local isolated Linux arm64 systemd container',results:[]};
try{
const policy=store.preparePolicyPlan('qa-host',{capabilities:enabled},user.id);store.applyPolicy('qa-host',policy.id,{confirm:true,expected_revision:policy.revision},user.id);
const bootstrap=store.issueBootstrap('qa-host',enabled,user.id);
await child('/bin/sh',['/opt/lm060-package/executor/install.sh','--release-dir','/opt/lm060-package','--artifact-sha256','a'.repeat(64)],JSON.stringify(bootstrap));
report.results.push('fresh same-package installation and Ed25519 enrollment');
// The isolated test CA is explicitly trusted, never TLS verification disabled.
// Worker still holds the exact production flock. Public-CA production unit is
// tested separately; this local override exists solely for the test CA.
mkdirSync('/etc/systemd/system/lightmoni-executor.service.d',{recursive:true});
writeFileSync('/etc/systemd/system/lightmoni-executor.service.d/qa.conf','[Service]\nExecStart=\nExecStart=/usr/bin/flock --exclusive --nonblock /var/lib/lightmoni-executor/writer.lock /opt/lightmoni-executor/current/node /opt/lightmoni-executor/current/app/runtime/dist/privileged-executor/main.js worker --config /etc/lightmoni-executor/config.json\nEnvironment=NODE_EXTRA_CA_CERTS='+dir+'/tls.crt\n');
execFileSync('systemctl',['daemon-reload']);execFileSync('systemctl',['restart','lightmoni-executor.service']);
await wait(()=>store.getStatus('qa-host').capabilities['script.elevated.v1'].effective==='ready');
const status=store.getStatus('qa-host'),account=status.script_profiles.accounts.find(a=>a.uid===0);
assert.equal(account.name,'root');assert.equal(status.executor.release.build_id,'sdd060-linux-qa');
const make=(code,timeout=15000)=>{const p=store.plan({host_ids:['qa-host'],capability:'script.elevated.v1',payload:{kind:'script',runtime:'shell',code,args:[],cwd_profile:'private',environment:{TEST_DUMMY_SECRET:'test-value'},account,interpreter_sha256:store.getStatus('qa-host').script_profiles.interpreters.shell,timeout_ms:timeout,max_output_bytes:8192}},user.id);return store.apply(p.id,{confirm:true,expected_revision:p.revision,request_id:randomUUID()},user.id).jobs[0]};
const job=make('id -u\nid -un\nprintf "qa-output\\n"\n');
const result=await wait(()=>{const j=store.get(job.id);return !['queued','running'].includes(j.state)&&j;},45000);
assert.equal(result.state,'succeeded',JSON.stringify(result));
const output=store.output(job.id,user.id);assert.equal(output.stdout,'0\nroot\nqa-output\n');
const lineage=db.get('SELECT * FROM task_runs WHERE id=?',job.id);assert.equal(lineage.execution_principal,'privileged_executor');assert.equal(lineage.stdout,'');assert(!lineage.snapshot_json.includes('TEST_DUMMY_SECRET'));
report.results.push('real signed plan + start permit + transient systemd process executes as UID 0/root');
assert.throws(()=>tasks.cancel(job.id,user.id),/principal_mismatch/);
report.results.push('ordinary task control rejects executor lineage and omits code/env/output');
await wait(()=>{const raw=execFileSync('/usr/local/bin/lightmoni-executor',['status','--config','/etc/lightmoni-executor/config.json'],{encoding:'utf8'});const s=JSON.parse(raw);return s.fenced===null&&s.pending_results===0;});
const timeoutJob=make('sleep 20\n',1000);
const timed=await wait(()=>{const j=store.get(timeoutJob.id);return !['queued','running'].includes(j.state)&&j;},30000);
assert.equal(timed.state,'failed',JSON.stringify(timed));assert.equal(timed.code,'timeout');
await wait(()=>{const raw=execFileSync('/usr/local/bin/lightmoni-executor',['status','--config','/etc/lightmoni-executor/config.json'],{encoding:'utf8'});const s=JSON.parse(raw);return s.fenced===null&&s.pending_results===0;});
report.results.push('real signed runtime limit stops sleep 20 at 1 second with failed/timeout and no unknown writer fence');
if(dockerImage){
  await wait(()=>store.getStatus('qa-host').capabilities['container.managed.v1'].effective==='ready');
  const containerJob=async payload=>{
    const p=store.plan({host_ids:['qa-host'],capability:'container.managed.v1',payload:{kind:'container',resource_id:'qa-owned-container',resource_revision:1,timeout_ms:15000,max_output_bytes:262144,...payload}},user.id);
    const job=store.apply(p.id,{confirm:true,expected_revision:p.revision,request_id:randomUUID()},user.id).jobs[0];
    const result=await wait(()=>{const j=store.get(job.id);return !['queued','running'].includes(j.state)&&j;},45000);
    await wait(()=>{const raw=execFileSync('/usr/local/bin/lightmoni-executor',['status','--config','/etc/lightmoni-executor/config.json'],{encoding:'utf8'});const s=JSON.parse(raw);return s.fenced===null&&s.pending_results===0;});
    return {result,output:store.output(job.id,user.id)};
  };
  const listed=await containerJob({operation:'list'});assert.equal(listed.result.state,'succeeded');
  assert(!listed.output.stdout.includes('Mounts'));assert(!listed.output.stdout.includes('Env'));
  const denied=await containerJob({operation:'stop',resource_id:'qa-external-not-managed'});assert.equal(denied.result.state,'failed');assert.equal(denied.result.code,'resource_not_managed');
  const created=await containerJob({operation:'create',image:dockerImage,platform:'linux/'+(process.arch==='arm64'?'arm64':'amd64')});assert.equal(created.result.state,'succeeded',JSON.stringify(created.result));
  const description=JSON.parse(created.output.stdout);assert.equal(description.resource.managed,true);assert(/^[a-f0-9]{64}$/.test(description.resource.docker_id));
  const removed=await containerJob({operation:'remove'});assert.equal(removed.result.state,'succeeded',JSON.stringify(removed.result));
  report.results.push('real Docker fixed Unix socket: sanitized list, external-resource refusal, digest/architecture-pinned managed create and remove; no existing container changed');
}
const revoke=store.preparePolicyPlan('qa-host',{capabilities:[]},user.id);store.applyPolicy('qa-host',revoke.id,{confirm:true,expected_revision:revoke.revision},user.id);
await wait(()=>db.get('SELECT observation_enc FROM privileged_executors WHERE id=?',bootstrap.executor_id)&&JSON.parse(deps.decrypt(db.get('SELECT observation_enc FROM privileged_executors WHERE id=?',bootstrap.executor_id).observation_enc)).policy_generation===revoke.generation,15000);
report.results.push('signed policy disable reaches independent executor');
await assert.rejects(child('/usr/local/sbin/lightmoni-executor-uninstall',['--confirm-remove-executor']),/executor_unmanaged_service/);
assert(existsSync('/etc/lightmoni-executor/config.json'));assert(existsSync('/var/lib/lightmoni-executor/journal.sqlite'));
report.results.push('production uninstaller refuses the explicit QA unit drop-in and preserves identity/journal');
// Remove only this harness's explicit test-CA drop-in before exercising the
// production uninstaller. It correctly rejects all external unit overrides.
execFileSync('systemctl',['stop','lightmoni-executor.service']);
execFileSync('/bin/rm',['/etc/systemd/system/lightmoni-executor.service.d/qa.conf']);
execFileSync('/bin/rmdir',['/etc/systemd/system/lightmoni-executor.service.d']);
execFileSync('systemctl',['daemon-reload']);
// Run the unmodified production lifecycle shell and standalone root supervisor.
// The fixed production unit does not inherit the fixture CA: this portion proves
// local program/lock/state lifecycle. Center receipt+activation-heartbeat joining
// is covered separately by the real-signed HTTP integration tests.
execFileSync('systemctl',['start','lightmoni-executor.service']);
const probeProgram=async()=>JSON.parse(await child('/bin/sh',['-c',executorProgramProbeCommand()]));
const initialProgram=await probeProgram();
const identityBytes=readFileSync('/etc/lightmoni-executor/config.json');
const journalSnapshot=()=>{const connection=new DatabaseSync('/var/lib/lightmoni-executor/journal.sqlite',{readOnly:true});try{return JSON.stringify({metadata:connection.prepare('SELECT * FROM metadata ORDER BY key').all(),jobs:connection.prepare('SELECT * FROM jobs ORDER BY job_id').all()});}finally{connection.close();}};
const initialJournal=journalSnapshot();
const work='/run/lightmoni-executor-maintenance.qacompletion';mkdirSync(work,{mode:0o700});
const pack=work+'/package';mkdirSync(pack,{mode:0o700});
cpSync('/opt/lm060-package',pack+'/lightmoni-agent-runtime',{recursive:true});
const nextManifest={...JSON.parse(readFileSync(pack+'/lightmoni-agent-runtime/release.json','utf8')),version:'0.1.1',build_id:'sdd060-linux-qa-next',source_revision:'b'.repeat(40)};
writeFileSync(pack+'/lightmoni-agent-runtime/release.json',JSON.stringify(nextManifest));
const archive=work+'/bundle.tar.gz';execFileSync('/usr/bin/tar',['-czf',archive,'-C',pack,'lightmoni-agent-runtime']);
const archiveSHA=createHash('sha256').update(readFileSync(archive)).digest('hex');
const target={version:nextManifest.version,build_id:nextManifest.build_id,source_revision:nextManifest.source_revision,artifact_sha256:archiveSHA,state_schema:1,arch:nextManifest.arch};
const applyProgram=async(action,target)=>{
  const before=await probeProgram(),operation=randomUUID();
  if(action==='upgrade')maintenanceArchives.set(operation,archive);
  const request={operation_id:operation,action,executor_id:before.executor_id,machine_id:before.machine_id,agent_id:before.agent_id,center_instance_id:before.center_instance_id,public_key_sha256:before.public_key_sha256,install_generation:before.install_generation,expected_fingerprint:before.current.fingerprint,expected_policy_generation:before.policy_generation,target,start_deadline:new Date(Date.now()+240000).toISOString()};
  const result=JSON.parse(await child('/bin/sh',['-c',executorProgramApplyCommand('https://localhost:19443',operation,action==='upgrade')],'qa-maintenance-ticket\n'+JSON.stringify(request),{CURL_CA_BUNDLE:dir+'/tls.crt'}));
  return {operation,result};
};
const upgraded=await applyProgram('upgrade',target);
assert.equal(upgraded.result.receipt.status,'started',JSON.stringify(upgraded.result));assert.equal(upgraded.result.observation.current.artifact_sha256,archiveSHA);
assert.deepEqual(upgraded.result.observation.previous,initialProgram.current);
assert.equal(upgraded.result.receipt.activation_id,upgraded.operation);
const upgradedRead=JSON.parse(await child('/bin/sh',['-c',executorProgramStatusCommand()],JSON.stringify({operation_id:upgraded.operation})));
assert.equal(upgradedRead.receipt.operation_id,upgraded.operation);assert.equal(upgradedRead.receipt.status,'started');
const rolled=await applyProgram('rollback',upgraded.result.observation.previous);
assert.equal(rolled.result.receipt.status,'started',JSON.stringify(rolled.result));assert.deepEqual(rolled.result.observation.current,initialProgram.current);
assert.equal(rolled.result.receipt.activation_id,rolled.operation);
assert.deepEqual(readFileSync('/etc/lightmoni-executor/config.json'),identityBytes);assert.equal(journalSnapshot(),initialJournal);
report.results.push('production root lifecycle shell downloads a real SHA-256 fixture archive, upgrades and exact-rolls back with distinct activation receipts; identity and complete logical journal retained');
// Queue a second writer behind the active worker: once maintenance stops the
// service this competing process wins. The supervisor must retain unknown and
// provide a new reviewed repair, never silently restart/replay the old request.
const contender=spawn('/usr/bin/flock',['--exclusive','/var/lib/lightmoni-executor/writer.lock','/bin/sh','-c','printf "qa-writer-held\\n"; cat >/dev/null'],{stdio:['pipe','pipe','pipe']});
let held='';contender.stdout.on('data',value=>held+=value);
await new Promise(resolve=>setTimeout(resolve,150));
const interrupted=await applyProgram('upgrade',target);
assert.equal(interrupted.result.receipt.status,'unknown',JSON.stringify(interrupted.result));assert.equal(interrupted.result.observation.service_active,false);
assert.equal(interrupted.result.observation.repairable,true);assert(held.includes('qa-writer-held'));
contender.stdin.end();await once(contender,'exit');
const beforeReadonly=journalSnapshot();
const interruptedRead=JSON.parse(await child('/bin/sh',['-c',executorProgramStatusCommand()],JSON.stringify({operation_id:interrupted.operation})));
assert.equal(interruptedRead.receipt.status,'unknown');assert.equal(journalSnapshot(),beforeReadonly);
const repaired=await applyProgram('repair',interruptedRead.observation.current);
assert.equal(repaired.result.receipt.status,'started',JSON.stringify(repaired.result));assert.equal(repaired.result.receipt.activation_id,repaired.operation);
assert.deepEqual(readFileSync('/etc/lightmoni-executor/config.json'),identityBytes);assert.equal(journalSnapshot(),initialJournal);
report.results.push('real stop-to-writer contention remains durable unknown; read-only status does not mutate journal; a new exact explicit repair request starts without re-enrollment or old operation replay');
report.lifecycle_fixture_artifact_sha256=archiveSHA;
await child('/usr/local/sbin/lightmoni-executor-uninstall',['--confirm-remove-executor']);
store.revokeExecutor('qa-host',bootstrap.executor_id,user.id);
assert.equal(store.getStatus('qa-host').executor.state,'revoked');
report.results.push('offline uninstall clears local executor state; exact center identity separately revoked');
report.pass=true;console.log(JSON.stringify(report,null,2));
}catch(e){report.pass=false;report.error=String(e);console.error(JSON.stringify(report,null,2));process.exitCode=1;}
finally{writeFileSync(dir+'/report.json',JSON.stringify(report,null,2));server.closeAllConnections();await new Promise(r=>server.close(r));tasks.close?.();db.close();}
