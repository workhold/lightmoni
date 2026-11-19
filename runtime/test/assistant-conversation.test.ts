import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseAttachments,hydrateAttachments} from '../src/assistant/attachments.js';
import {sessionStatus} from '../src/assistant/session-status.js';
import type {Session,Event} from '../src/assistant/types.js';

const jpeg=Buffer.from([0xff,0xd8,0xff,0xd9]).toString('base64');

test('attachments validate bytes, metadata, names and PDF text before acceptance',()=>{
  const values=parseAttachments([{kind:'image',name:'screen.jpg',mime_type:'image/jpeg',data:jpeg},{kind:'pdf',name:'guide.pdf',mime_type:'application/pdf',text:'page text',pages:1}]);
  assert.equal(values.length,2);
  assert.equal(values[0].ref.data,undefined);
  assert.equal(values[1].ref.text,undefined);
  assert.throws(()=>parseAttachments([{kind:'image',name:'bad.jpg',mime_type:'image/jpeg',data:Buffer.from('plain').toString('base64')}]),/invalid/);
  assert.throws(()=>parseAttachments([{kind:'pdf',name:'scan.pdf',mime_type:'application/pdf',text:' ',pages:2}]),/unreadable/);
  assert.throws(()=>parseAttachments([{kind:'pdf',name:'../escape.pdf',mime_type:'application/pdf',text:'hello',pages:1}]),/name/);
});

test('hydration keeps secret bytes out of stored message references and prioritizes recent media',()=>{
  const data='a'.repeat(900_000);
  const messages=[
    {role:'user',content:'old',attachments:[{id:'old',kind:'image' as const,name:'old.jpg',mime_type:'image/jpeg'}]},
    {role:'user',content:'new',attachments:[{id:'new',kind:'image' as const,name:'new.jpg',mime_type:'image/jpeg'}]},
  ];
  const hydrated=hydrateAttachments(messages,id=>id==='old'?data:data);
  assert.equal(messages[0].attachments[0].data,undefined);
  assert.equal(hydrated[0].attachments?.[0].data,undefined);
  assert.equal(hydrated[1].attachments?.[0].data,data);
});

const event=(sequence:number,type:string,data:Record<string,unknown>={}):Event=>({sequence,session_id:'s',turn_id:'t',type,timestamp:'2026-11-19T00:00:00Z',data});
const session=(events:Event[]):Session=>({id:'s',user_id:'u',title:'test',created_at:'',updated_at:'',messages:[],events});

test('session status distinguishes live, failed, awaiting approval and settled turns',()=>{
  const base=[event(0,'user.message',{text:'x'})];
  assert.equal(sessionStatus(session(base),true),'running');
  assert.equal(sessionStatus(session(base),false),'failed');
  assert.equal(sessionStatus(session([...base,event(1,'turn.failed')]),false),'failed');
  assert.equal(sessionStatus(session([...base,event(1,'tool.result',{status:'success',value:{proposal:{status:'awaiting_approval'}}}),event(2,'turn.completed')]),false),'needs_action');
  assert.equal(sessionStatus(session([...base,event(1,'tool.result',{status:'success',tool:'draft_dashboard',value:{draft:{title:'Review'}}}),event(2,'turn.completed')]),false),'needs_action');
  assert.equal(sessionStatus(session([...base,event(1,'tool.result',{status:'success',value:{proposal:{status:'awaiting_approval'}}}),event(2,'turn.completed')]),false,()=>false),'idle');
  assert.equal(sessionStatus(session([...base,event(1,'turn.completed')]),false),'idle');
});
