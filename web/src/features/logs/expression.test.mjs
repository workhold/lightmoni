import test from 'node:test';
import assert from 'node:assert/strict';
import {parseExpression} from './expression.ts';
const columns=[{name:'service',type:'String'},{name:'severity',type:'String'},{name:'source_seq',type:'UInt64'}];
test('field expressions become typed editable filters and retain literal body search',()=>{
 const result=parseExpression('payment service:"billing api" AND level:ERROR @status>=500 @retryable:true',columns,[]);
 assert.equal(result.keyword,'payment');assert.equal(result.filters.length,4);assert.deepEqual(result.filters.map(f=>[f.scope,f.field,f.type,f.op,f.value]),[['column','service','string','eq','billing api'],['column','severity','string','eq','ERROR'],['attribute','status','number','gte',500],['attribute','retryable','boolean','eq',true]]);
});
test('exact integers and quoted numeric strings do not collapse their types',()=>{
 const result=parseExpression('source_seq:18446744073709551615 @sequence:18446744073709551615 @sequence:"18446744073709551615" @missing:*',columns,[]);
 assert.equal(result.filters[0].value,'18446744073709551615');assert.equal(result.filters[1].type,'number');assert.equal(result.filters[2].type,'string');assert.equal(result.filters[3].op,'exists');
});
test('invalid or ambiguous grammar gives a recoverable error before sending SQL',()=>{
 for(const input of ['unknown:thing','service:api OR service:billing','service:"unfinished','service>api'])assert.throws(()=>parseExpression(input,columns,[]));
 const result=parseExpression('service:"x\' OR 1=1 --"',columns,[]);assert.equal(result.filters[0].value,"x' OR 1=1 --");
});
