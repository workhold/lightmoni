import {test} from 'node:test';
import assert from 'node:assert/strict';
import {filterApplicationsByState,type Resource} from '../../web/src/app/ops/model.js';

test('application status filters keep counts aligned with visible lifecycle states',()=>{
 const item=(id:string,state:string):Resource=>({id,kind:'application',name:id,revision:1,spec:{},status:{state},created_at:'',updated_at:''});
 const resources=[item('ready','running'),item('failure','failed'),item('unconfirmed','unknown'),item('waiting','pending'),item('draft','configured'),item('offline','stopped')];
 const ids=(filter:string)=>filterApplicationsByState(resources,filter).map(r=>r.id);
 assert.deepEqual(ids('failed'),['failure','unconfirmed']);
 assert.deepEqual(ids('pending'),['waiting','draft']);
 assert.deepEqual(ids('running'),['ready']);
 assert.deepEqual(ids('stopped'),['offline']);
 assert.equal(ids('all').length,6);
 assert.deepEqual(filterApplicationsByState([], 'failed'),[]);
});
