/** Opt-in disposable Linux engine only. Random test secrets never enter reports. */
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile,readdir,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomBytes} from 'node:crypto';
import {selfSignedCertificate} from '../runtime/dist/ops/certificates.js';
import {normalizeWebsiteAuth} from '../runtime/dist/ops/website-auth.js';
import {preparePlatformImages} from '../runtime/dist/operations/image-sources.js';
import {pullAuthenticatedImage} from '../runtime/dist/operations/registry-auth.js';
import {commandDiagnostic} from '../runtime/dist/operations/install-progress.js';
if(process.platform!=='linux'||process.env.LIGHTMONI_REGISTRY_AUTH_LIVE!=='1')throw Error('Explicit disposable Linux engine required');
const root='/qa',registry='127.0.0.1:24443',image=registry+'/team/private:one',name='lm-registry-auth-live',secret=randomBytes(24).toString('base64url'),commands=[],checks=[];
const command=async(file,args,options={})=>{
 commands.push({file,args});
 try{return await promisify(execFile)(file,args,{env:{...process.env,...options.env},timeout:options.timeoutMs??30000,signal:options.signal,maxBuffer:1048576});}
 catch(error){throw Object.assign(Error('live_command_failed'),{diagnosticCode:commandDiagnostic(String(error.stderr??''),file==='docker')});}
};
const docker=(...args)=>command('docker',args,{timeoutMs:120000});
const config=join(root,'registry'),authDirectory=join(root,'runtime');await mkdir(config,{recursive:true,mode:0o700});await mkdir(authDirectory,{recursive:true,mode:0o700});
const cert=await selfSignedCertificate(['127.0.0.1'],1,new Date());await writeFile(join(config,'cert.pem'),cert.certificate_pem,{mode:0o600});await writeFile(join(config,'key.pem'),cert.private_key_pem,{mode:0o600});
const auth=normalizeWebsiteAuth({mode:'basic',users:[{username:'robot',password:secret}]},undefined);await writeFile(join(config,'htpasswd'),'robot:'+auth.users[0].password_hash+'\n',{mode:0o600});
await mkdir(join(root,'certs',registry),{recursive:true});await writeFile(join(root,'certs',registry,'ca.crt'),cert.certificate_pem,{mode:0o600});
try{
 await docker('run','-d','--name',name,'--network','host','--mount','type=bind,src=/qa/registry,dst=/auth,readonly','-e','REGISTRY_HTTP_ADDR=127.0.0.1:24443','-e','REGISTRY_HTTP_DEBUG_ADDR=127.0.0.1:0','-e','REGISTRY_HTTP_TLS_CERTIFICATE=/auth/cert.pem','-e','REGISTRY_HTTP_TLS_KEY=/auth/key.pem','-e','REGISTRY_AUTH=htpasswd','-e','REGISTRY_AUTH_HTPASSWD_REALM=QA','-e','REGISTRY_AUTH_HTPASSWD_PATH=/auth/htpasswd','registry:3.0.0');
 await docker('tag','alpine:3.23',image);
 const push=join(root,'push');await mkdir(push,{mode:0o700});await writeFile(join(push,'config.json'),JSON.stringify({auths:{[registry]:{auth:Buffer.from('robot:'+secret).toString('base64')}}}),{mode:0o600});
 let ready=false;for(let n=0;n<50;n++){try{await command('docker',['--config',push,'push',image],{timeoutMs:120000});ready=true;break;}catch{await new Promise(r=>setTimeout(r,200));}}assert(ready,'TLS registry did not accept push');await rm(push,{recursive:true,force:true});
 checks.push('real TLS Registry with bcrypt authentication accepts a test image push');
 await docker('image','rm',image);await assert.rejects(docker('image','pull',image));checks.push('anonymous pull is denied');
 let current=secret;
 const context={dataDir:root,registryAuthDirectory:authDirectory,registryCredential:async()=>({registry,repository_prefix:'team',username:'robot',password:current}),command,signal:new AbortController().signal,now:()=>new Date()};
 const policy={registry_authorizations:[{id:'a'.repeat(32),revision:1,registry,repository_prefix:'team',images:[image]}]};
 const manifest={services:{app:{image}}};const result=await preparePlatformImages(manifest,policy,root,context);assert.match(manifest.services.app.image,/^sha256:[a-f0-9]{64}$/);assert.equal(manifest.services.app.pull_policy,'never');assert.equal(result[0].source,'authenticated-registry');checks.push('production image preparation authenticates then pins a verified image ID');
 const container=await docker('run','--rm',manifest.services.app.image,'sh','-c','printf registry-auth-ok');assert.equal(container.stdout,'registry-auth-ok');checks.push('the prepared private image starts a real container');
 const compose={services:{app:{image}}};await preparePlatformImages(compose,{...policy,refresh_images:true},root,context);assert.match(compose.services.app.image,/^sha256:/);checks.push('forced refresh and Compose preparation use the same credential path');
 current='incorrect-test-password';await assert.rejects(pullAuthenticatedImage(image,context),e=>e.diagnosticCode==='image_access_denied');assert.deepEqual(await readdir(authDirectory),[]);checks.push('wrong credentials fail with a safe access-denied diagnostic and all temporary auth files are removed');
 assert(!JSON.stringify(commands).includes(secret));const report={checks,passed:true,scope:'Disposable isolated Docker engine, TLS registry and random test credentials; no production changes'};
 const output=resolve('specs/111-registry-pull-credentials/evidence');await mkdir(output,{recursive:true});await writeFile(join(output,'registry-live.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await docker('rm','-f',name).catch(()=>{});await rm(authDirectory,{recursive:true,force:true});await rm(config,{recursive:true,force:true});}
