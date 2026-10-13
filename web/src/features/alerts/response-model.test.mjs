import test from 'node:test';
import assert from 'node:assert/strict';
import {loadSource} from '../dashboards/test-module.mjs';

const {normalizeResponseGroup,rulePriority}=loadSource(new URL('./response-model.ts',import.meta.url));
const policy={methods:['email'],weekdays:[],repeat_seconds:60,max_rounds:3};
const defaults={P0:{...policy,methods:['voice','sms']},P2:policy};

test('partially configured API groups with Go null slices can open and edit schedules',()=>{
 const raw={id:'existing',name:'现有组',revision:3,members:null,primary:null,backup:null,fallback:null,channel_ids:null,targets:null,timezone:'',policies:null,schedule:{mode:'',timezone:'',anchor:'',interval_days:0,shifts:null,overrides:null}};
 const group=normalizeResponseGroup(raw,defaults);
 assert.equal(group.id,'existing');assert.equal(group.revision,3);
 for(const field of ['members','primary','backup','fallback','channel_ids','targets'])assert.deepEqual(group[field],[]);
 assert.equal(group.members.includes('person'),false);
 assert.equal(group.timezone,'Asia/Shanghai');assert.equal(group.schedule.mode,'fixed');
 assert.ok(Number.isFinite(Date.parse(group.schedule.anchor)));
 assert.deepEqual(group.schedule.shifts,[]);assert.deepEqual(group.schedule.overrides,[]);
 assert.equal(group.policies.P2.repeat_seconds,60);
 assert.equal(raw.members,null);assert.equal(raw.schedule.anchor,'');
});

test('valid cyclic groups keep their configured users, time and policies while nullable shifts are safe',()=>{
 const raw={id:'rotation',members:['a','b'],primary:['a'],backup:['b'],timezone:'UTC',schedule:{mode:'weekly',timezone:'UTC',anchor:'2026-10-12T01:00:00Z',interval_days:7,shifts:[{primary:['a'],backup:null},{primary:null,backup:['b']}],overrides:[{id:'override',from:'2026-10-13T01:00:00Z',until:'2026-10-13T02:00:00Z',primary:['b'],backup:null}]},policies:{P2:{...policy,repeat_seconds:300}}};
 const group=normalizeResponseGroup(raw,defaults);
 assert.deepEqual(group.members,['a','b']);assert.equal(group.schedule.anchor,raw.schedule.anchor);
 assert.deepEqual(group.schedule.shifts,[{primary:['a'],backup:[]},{primary:[],backup:['b']}]);
 assert.deepEqual(group.schedule.overrides[0].backup,[]);
 assert.equal(group.policies.P2.repeat_seconds,300);assert.deepEqual(group.policies.P0.methods,['voice','sms']);
 group.policies.P0.methods.push('chat');assert.deepEqual(defaults.P0.methods,['voice','sms']);
});

test('displayed rule levels match backend aliases and retain every explicit level',()=>{
 for(const p of ['P0','P1','P2','P3'])assert.equal(rulePriority(p),p);
 assert.equal(rulePriority('critical'),'P0');assert.equal(rulePriority('warning'),'P2');assert.equal(rulePriority(''),'P2');
});
