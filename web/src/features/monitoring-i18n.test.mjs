import test from 'node:test';
import assert from 'node:assert/strict';
import {monitoringText} from './monitoring-translations.ts';
import {parseExpression} from './logs/expression.ts';
import {loadSource} from './dashboards/test-module.mjs';
const {bindQueries,resolveRange}=loadSource(new URL('./dashboards/model.ts',import.meta.url));

test('monitoring interface translation preserves business values and unknown labels',()=>{
 assert.equal(monitoringText('查询 {0}','en-US','支付日志'),'Query 支付日志');
 assert.equal(monitoringText('支付日志','en-US'),'支付日志');
 assert.equal(monitoringText('constructor','en-US'),'constructor');
 assert.equal(monitoringText('查询 {0}','zh-CN','服务甲'),'查询 服务甲');
});
test('English expression errors keep the original field name and typed query values',()=>{
 assert.throws(()=>parseExpression('unknown_field:42',[],[],'en-US'),/Unknown field unknown_field/);
 const parsed=parseExpression('@order:42',[],['order'],'en-US');
 assert.equal(parsed.filters[0].field,'order');assert.equal(parsed.filters[0].value,42);
 const queries=bindQueries([{refId:'A',sql:'SELECT {service:String}'}],[{name:'service',type:'text'}],{service:'支付服务'}, {},'en-US');
 assert.equal(queries[0].sql,'SELECT {service:String}');assert.equal(queries[0].params.service.value,'支付服务');
 assert.throws(()=>resolveRange({from:'now',to:'now-1h'},undefined,'en-US'),/Start time must be before end time/);
});
