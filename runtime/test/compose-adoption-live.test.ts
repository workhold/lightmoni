import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {executeCompose} from '../src/operations/containers.js';
import {operationCommand} from '../src/agent/operations.js';
import type {OperationPayload} from '../src/operations/types.js';
const exec=promisify(execFile);

test('real external Compose adoption retains its original project, named volume and data while recreating only its services',{skip:process.env.LIGHTMONI_DOCKER_LIVE!=='1'},async t=>{
 const root=await mkdtemp(join(tmpdir(),'lm117-adopt-')),project='lm117-adopt-'+randomUUID().slice(0,8),source=join(root,'original.json'),id=randomUUID().replaceAll('-','');
 const docker=async(args:string[])=>(await exec('docker',['--context','default',...args],{timeout:90000})).stdout.trim();
 const compose={services:{app:{image:'alpine:3.23',command:['sh','-c','test -f /data/sentinel || printf preserved > /data/sentinel; exec sleep 600'],volumes:['data:/data']}},volumes:{data:{}}};
 await writeFile(source,JSON.stringify(compose),{mode:0o600});
 t.after(async()=>{await docker(['compose','--project-name',project,'--file',source,'down','--remove-orphans']).catch(()=>{});await docker(['volume','rm',project+'_data']).catch(()=>{});await rm(root,{recursive:true,force:true})});
 await docker(['image','inspect','alpine:3.23']);await docker(['compose','--project-name',project,'--file',source,'up','--detach','--wait','--pull','never']);
 const before=await docker(['compose','--project-name',project,'--file',source,'ps','--quiet']);assert.equal(await docker(['exec',before,'cat','/data/sentinel']),'preserved');
 const context={dataDir:root,signal:new AbortController().signal,now:()=>new Date(),command:operationCommand};
 const payload=(operation:string,input:Record<string,unknown>):OperationPayload=>({version:1,operation_id:randomUUID().replaceAll('-',''),operation,input,resource:{id,kind:'compose',name:project,agent_id:'disposable-agent',revision:1,config:{project_name:project,compose},created_at:new Date().toISOString(),updated_at:new Date().toISOString()}});
 const inspection=await executeCompose(payload('inspect',{}),context);assert.equal(inspection.data.adoption_supported,true);assert.equal(inspection.data.generation,0);assert.equal(inspection.data.volumes[0].name,project+'_data');
 const adopted=await executeCompose(payload('adopt',{expected_generation:0,inventory_sha256:inspection.data.inventory_sha256,acknowledge_recreate:true}),context);assert.equal(adopted.verified,true);assert.equal(adopted.data.recreated_existing_containers,true);
 const after=await docker(['compose','--project-name',project,'--file',source,'ps','--quiet']);assert.notEqual(after,before);assert.equal(after.split('\n').length,1);assert.equal(await docker(['exec',after,'cat','/data/sentinel']),'preserved');assert.equal(await docker(['volume','inspect',project+'_data','--format','{{.Name}}']),project+'_data');
 const reread=await executeCompose(payload('inspect',{}),context);assert.equal(reread.data.managed,true);assert.equal(reread.data.generation,1);assert.equal(reread.data.project_name,project);assert.equal(reread.data.containers.length,1);
});
