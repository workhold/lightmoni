import test from "node:test";
import assert from "node:assert/strict";
import {generateKeyPairSync,randomUUID} from "node:crypto";
import {validateExecutorActivation} from "../src/privileged-executor/activation.js";
import {executorPublicKey,type ExecutorConfig} from "../src/privileged-executor/config.js";
import {sha256} from "../src/shared/privileged-executor.js";

function fixture(){
 const key=generateKeyPairSync("ed25519"),config={executor_id:"executor",machine_id:"machine",agent_id:"agent",center_instance_id:"center",install_generation:2,private_key:key.privateKey.export({type:"pkcs8",format:"pem"}).toString()} as ExecutorConfig;
 const release={version:"version",release:{build_id:"build",source_revision:"a".repeat(40),artifact_sha256:"b".repeat(64),state_schema:1 as const}};
 const identity={executor_id:config.executor_id,machine_id:config.machine_id,agent_id:config.agent_id,center_instance_id:config.center_instance_id,install_generation:config.install_generation,public_key_sha256:sha256(executorPublicKey(config))};
 const marker={schema:1,maintenance_protocol:1,phase:"ready",activation_id:randomUUID(),release_name:"build",identity,release:{version:release.version,...release.release,release_dir:"/opt/lightmoni-executor/releases/build"},updated_at:"2026-11-01T00:00:00Z"};
 return{config,release,marker};
}
test("activation is captured from exact root phase identity and running release",()=>{
 const f=fixture(),captured=validateExecutorActivation(f.marker,f.config,f.release,"/opt/lightmoni-executor/releases/build");f.marker.activation_id=randomUUID();assert.notEqual(captured,validateExecutorActivation(f.marker,f.config,f.release,"/opt/lightmoni-executor/releases/build"));
});
test("activation refuses old format, mismatched identity, release and incomplete enrollment",()=>{
 for(const field of ["executor_id","machine_id","agent_id","center_instance_id","install_generation","public_key_sha256"]){const f=fixture();(f.marker.identity as any)[field]=field==="install_generation"?3:"other";assert.throws(()=>validateExecutorActivation(f.marker,f.config,f.release,"/opt/lightmoni-executor/releases/build"));}
 for(const change of [{activation_id:""},{activation_id:"legacy"},{maintenance_protocol:0},{phase:"unknown"},{identity:null}]){const f=fixture();assert.throws(()=>validateExecutorActivation({...f.marker,...change},f.config,f.release,"/opt/lightmoni-executor/releases/build"));}
 const f=fixture();assert.throws(()=>validateExecutorActivation(f.marker,f.config,f.release,"/opt/lightmoni-executor/releases/other"));assert.throws(()=>validateExecutorActivation({...f.marker,release:{...f.marker.release,artifact_sha256:"c".repeat(64)}},f.config,f.release,"/opt/lightmoni-executor/releases/build"));
});
test("initial enrollment alone may read a pending same-release activation before identity is recorded",()=>{
 const f=fixture(),pending={...f.marker,phase:"enrollment_pending",identity:null};assert.equal(validateExecutorActivation(pending,f.config,f.release,"/opt/lightmoni-executor/releases/build",true),f.marker.activation_id);assert.throws(()=>validateExecutorActivation(pending,f.config,f.release,"/opt/lightmoni-executor/releases/build"));assert.throws(()=>validateExecutorActivation({...pending,phase:"start"},f.config,f.release,"/opt/lightmoni-executor/releases/build",true));
});
