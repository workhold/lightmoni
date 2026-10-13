import test from 'node:test';
import assert from 'node:assert/strict';
import {loadSource} from '../dashboards/test-module.mjs';

const {normalizeAlertPreview}=loadSource(new URL('./alert-preview.ts',import.meta.url));
const {groupHasNotificationTargets}=loadSource(new URL('./response-model.ts',import.meta.url));

test('preview DTO accepts empty arrays and null transport fields without hiding selected severity',()=>{
 const input=JSON.parse('{"states":null,"routes":null,"warnings":null}');
 const data=normalizeAlertPreview(input,{name:'CPU告警',severity:'P1'});
 assert.equal(data.rule_name,'CPU告警');assert.equal(data.severity,'P1');
 assert.deepEqual(data.states,[]);assert.deepEqual(data.routes,[]);assert.deepEqual(data.warnings,[]);
});

test('preview retains errors, fixed query window and routing while null labels and group IDs are safe',()=>{
 const input={range:{from:'2026-10-13T01:00:00Z',to:'2026-10-13T01:05:00Z'},states:[{health:'error',status:'normal',labels:null,value:'',error:'查询超时'}],routes:[{group_ids:null,target:{channel_id:'smtp',recipient:{kind:'email',value:'ops@example.com'}}}],warnings:['缺少备班']};
 const data=normalizeAlertPreview(input,{name:'请求告警',severity:'critical'});
 assert.equal(data.severity,'P0');assert.equal(data.states[0].error,'查询超时');
 assert.deepEqual(data.states[0].labels,{});assert.deepEqual(data.routes[0].group_ids,[]);
 assert.deepEqual(data.range,input.range);assert.deepEqual(data.warnings,['缺少备班']);
 assert.equal(data.routes[0].target.recipient.value,'ops@example.com');
 assert.equal(input.states[0].labels,null);assert.equal(input.routes[0].group_ids,null);
});

test('dashboard groups with users and system integrations do not require old address targets',()=>{
 assert.equal(groupHasNotificationTargets({members:['u1'],channel_ids:['feishu'],targets:null}),true);
 assert.equal(groupHasNotificationTargets({members:[],channel_ids:['feishu'],targets:null}),false);
 assert.equal(groupHasNotificationTargets({members:['u1'],channel_ids:[],targets:[]}),false);
 assert.equal(groupHasNotificationTargets({targets:[{channel_id:'local'}]}),true);
});
