import test from 'node:test';
import assert from 'node:assert/strict';
import {containerCreate,containerLimits,canonicalHostAction} from '../../web/src/app/host-container-model.js';
import {normalizeHostDockerAction,hostDockerHash} from '../src/shared/host-docker.js';

test('browser form values satisfy the signed node contract with exact units and argument boundaries',()=>{
 const config=containerCreate({name:'contract-qa',image_id:'sha256:'+'1'.repeat(64),command:'printf\nhello world',ports:'18080:80/tcp',volumes:'qa-data:/data:ro',start:false,memory_mib:64,cpus:0.5,restart:'on-failure',retry:3});
 assert.equal(config.memory_bytes,67108864);assert.equal(config.nano_cpus,500000000);assert.deepEqual(config.command,['printf','hello world']);
 const action={kind:'host_docker',operation:'create',config};assert.deepEqual(normalizeHostDockerAction(action),action);assert.equal(hostDockerHash(normalizeHostDockerAction(action)),hostDockerHash(action));
});
test('invalid port/volume syntax or unsafe limits fail before the browser can submit a task',()=>{
 for(const bad of [{ports:'8080:80',volumes:''},{ports:'65536:80/tcp',volumes:''},{ports:'',volumes:'/host:/data:rw'},{ports:'',volumes:'data:relative:rw'}])assert.throws(()=>containerCreate({name:'qa',image_id:'sha256:'+'1'.repeat(64),memory_mib:32,cpus:0,restart:'no',...bad}));
 for(const values of [{memory_mib:2,cpus:1,restart:'no'},{memory_mib:0,cpus:1025,restart:'no'},{memory_mib:32,cpus:0,restart:'on-failure',retry:101}])assert.throws(()=>containerLimits(values));
});
test('request recovery compares structured actions independently of server object key order',()=>{
 const a={kind:'host_docker',operation:'remove',container_id:'a'.repeat(64),expected_revision:'b'.repeat(64),force:false,remove_anonymous_volumes:false};
 const b=Object.fromEntries(Object.entries(a).reverse());assert.equal(canonicalHostAction(a),canonicalHostAction(b));assert.notEqual(canonicalHostAction(a),canonicalHostAction({...a,force:true}));
});
