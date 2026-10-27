import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm, mkdir, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:https';
import { certificateDefinition, executeCertificate } from '../src/operations/certificates.js';
import type { OperationExecutionContext, OperationPayload } from '../src/operations/types.js';

async function material(dir:string,name:string,domain='example.test') {
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(dir,`${name}.key`),'-out',join(dir,`${name}.crt`),'-days','2','-subj','/CN=example.test','-addext',`subjectAltName=DNS:${domain}`],{stdio:'ignore'});
  return {certificate_pem:await readFile(join(dir,`${name}.crt`),'utf8'),private_key_pem:await readFile(join(dir,`${name}.key`),'utf8')};
}
const payload=(config:any,operation='install'):OperationPayload=>({version:1,operation_id:'run-one',operation,resource:{id:'cert-one',kind:'certificate',name:'Example certificate',agent_id:'node-one',revision:1,config,created_at:'',updated_at:''},input:{}});
const context=(dataDir:string):OperationExecutionContext=>({dataDir,publicDir:dataDir+'-public',signal:new AbortController().signal,now:()=>new Date(),command:async()=>({stdout:'',stderr:''})});

test('certificate validation checks identity and public config never returns PEM',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'lightmoni-cert-'));
 try {
   const first=await material(dir,'first');const second=await material(dir,'second');
   const config=certificateDefinition.validate({domains:['example.test'],...first});
   assert.equal(certificateDefinition.publicConfig(config).has_private_key,true);
   assert.ok(!JSON.stringify(certificateDefinition.publicConfig(config)).includes('BEGIN'));
   assert.throws(()=>certificateDefinition.validate({domains:['example.test'],...first,private_key_pem:second.private_key_pem}),/CERTIFICATE_KEY_MISMATCH/);
   assert.throws(()=>certificateDefinition.validate({domains:['other.test'],...first}),/CERTIFICATE_DOMAIN_MISMATCH/);
 }finally{await rm(dir,{recursive:true,force:true});await rm(dir+'-public',{recursive:true,force:true});}
});

test('certificate install stores secret mode 0600 and returns verified expiry metadata',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'lightmoni-cert-'));
 try {
   const keys=await material(dir,'first');
   const result=await executeCertificate(payload({domains:['example.test'],...keys}),context(dir));
   assert.equal(result.verified,true);assert.ok(result.data.days_remaining>0);
   assert.equal((await stat(join(dir,'operations','certificates','cert-one','private.key'))).mode & 0o777,0o600);
   assert.ok(!JSON.stringify(result).includes('BEGIN'));
 }finally{await rm(dir,{recursive:true,force:true});await rm(dir+'-public',{recursive:true,force:true});}
});

test('ACME requires a working owned port 80 gateway and a contact email',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'lightmoni-cert-'));
 try {
   assert.throws(()=>certificateDefinition.validateInput('issue',{}, {domains:['example.test']}),/ACME_EMAIL_REQUIRED/);
   await assert.rejects(executeCertificate(payload({domains:['example.test'],email:'ops@example.test'},'issue'),context(dir)),/ACME_GATEWAY_REQUIRED/);
 }finally{await rm(dir,{recursive:true,force:true});await rm(dir+'-public',{recursive:true,force:true});}
});

test('expired uploads cannot be installed, but existing expiry remains inspectable',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'lightmoni-cert-'));
 try{
  const keys=await material(dir,'first');const p=payload({domains:['example.test'],...keys});
  await executeCertificate(p,context(dir));
  const future={...context(dir),now:()=>new Date(Date.now()+4*86400000)};
  await assert.rejects(executeCertificate(p,future),/CERTIFICATE_NOT_CURRENTLY_VALID/);
  const result=await executeCertificate({...p,operation:'inspect'},future);
  assert.equal(result.data.expired,true);assert.ok(result.data.days_remaining<0);
 }finally{await rm(dir,{recursive:true,force:true});await rm(dir+'-public',{recursive:true,force:true});}
});


test('certificate replacement must cover every verified bound website before any files change',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'lightmoni-cert-'));
 try{
  const original=await material(dir,'original');await executeCertificate(payload({domains:['example.test'],...original}),context(dir));
  const gateway=join(dir,'operations','websites');const versionDir=join(gateway,'versions','site-one','version-one');await mkdir(versionDir,{recursive:true});
  await writeFile(join(gateway,'versions','site-one','state.json'),JSON.stringify({last_revision:1,active_version:'version-one',versions:['version-one']}));
  await writeFile(join(versionDir,'metadata.json'),JSON.stringify({revision:1,config:{domains:['example.test'],certificate_id:'cert-one',https_port:8443,listen_port:8088,mode:'static'},created_at:new Date().toISOString(),digest:'test'}));
  await writeFile(join(versionDir,'site.conf'),'verified website configuration');await writeFile(join(gateway,'active','site-one.conf'),'verified website configuration');
  const certificatePath=join(dir,'operations','certificates','cert-one','certificate.pem');const keyPath=join(dir,'operations','certificates','cert-one','private.key');
  const previousCertificate=await readFile(certificatePath,'utf8'),previousKey=await readFile(keyPath,'utf8');
  const replacement=await material(dir,'replacement','other.test');const p=payload({domains:['other.test'],...replacement});p.resource.revision=2;p.operation_id='run-two';
  await assert.rejects(executeCertificate(p,context(dir)),/CERTIFICATE_DOMAIN_MISMATCH/);
  assert.equal(await readFile(certificatePath,'utf8'),previousCertificate);assert.equal(await readFile(keyPath,'utf8'),previousKey);
 }finally{await rm(dir,{recursive:true,force:true});await rm(dir+'-public',{recursive:true,force:true});}
});


test('certificate rollback verifies the previous TLS fingerprint and reports failed recovery explicitly',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'lightmoni-cert-'));let server:ReturnType<typeof createServer>|undefined;
 try{
  const original=await material(dir,'original'),replacement=await material(dir,'replacement');
  await executeCertificate(payload({domains:['example.test'],...original}),context(dir));
  server=createServer({key:original.private_key_pem,cert:original.certificate_pem},(_req,res)=>res.end('configuration proof'));
  await new Promise<void>(resolve=>server!.listen(0,'127.0.0.1',resolve));const port=(server.address() as any).port;
  const gateway=join(dir,'operations','websites'),versionDir=join(gateway,'versions','site-one','version-one');await mkdir(versionDir,{recursive:true});
  await writeFile(join(gateway,'versions','site-one','state.json'),JSON.stringify({last_revision:1,active_version:'version-one',versions:['version-one']}));
  await writeFile(join(versionDir,'metadata.json'),JSON.stringify({revision:1,config:{domains:['example.test'],certificate_id:'cert-one',https_port:port,listen_port:8088,mode:'static'}}));
  await writeFile(join(versionDir,'site.conf'),'verified website configuration');await writeFile(join(gateway,'active','site-one.conf'),'verified website configuration');await writeFile(join(gateway,'nginx.pid'),String(process.pid));
  const canonical=await realpath(gateway);let reloads=0;
  const ctx:OperationExecutionContext={...context(dir),command:async(file,args)=>{
   if(file==='ps')return{stdout:`nginx: master process nginx -p ${canonical}/ -c ${canonical}/nginx.conf`,stderr:''};
   if(file==='nginx'&&args.includes('-s')&&args.includes('reload')&&++reloads===1)throw Error('simulate replacement reload failure');
   return{stdout:'',stderr:''};
  }};
  const p=payload({domains:['example.test'],...replacement});p.resource.revision=2;p.operation_id='run-two';
  await assert.rejects(executeCertificate(p,ctx),/^Error: CERTIFICATE_ACTIVATION_FAILED$/);
  assert.equal(await readFile(join(dir,'operations','certificates','cert-one','certificate.pem'),'utf8'),original.certificate_pem);
  server.setSecureContext({key:replacement.private_key_pem,cert:replacement.certificate_pem});reloads=0;
  await assert.rejects(executeCertificate(p,ctx),/CERTIFICATE_ACTIVATION_FAILED_RECOVERY_FAILED/);
 }finally{if(server)await new Promise<void>(resolve=>server!.close(()=>resolve()));await rm(dir,{recursive:true,force:true});await rm(dir+'-public',{recursive:true,force:true});}
});
