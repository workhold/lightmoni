import test from 'node:test';
import assert from 'node:assert/strict';
import {loadSource} from './test-module.mjs';
const {ChartRefreshQueue,ChartFrameBuffer}=loadSource(new URL('./chart-refresh.ts',import.meta.url));
const {chartDataSignature,retainHiddenSeries}=loadSource(new URL('./panel-refresh.ts',import.meta.url));
const flush=async()=>{await Promise.resolve();await Promise.resolve();};

function surface() {
 const source={width:1200,height:400,pixels:'previous complete frame'};
 const layers=[];
 const container={
  querySelector:()=>source,
  appendChild:canvas=>layers.push(canvas),
  ownerDocument:{defaultView:{getComputedStyle:()=>({backgroundColor:'rgb(24, 27, 31)'})},createElement:()=>({hidden:true,style:{},setAttribute(){},getContext(){return {drawImage:image=>{this.pixels=image.pixels;}};},remove(){layers.splice(layers.indexOf(this),1);}})},
 };
 const visible=()=>layers[0]&&!layers[0].hidden?layers[0].pixels:source.pixels;
 return {source,layers,container,visible};
}

test('last completed pixels remain visible during a blank live canvas and preserve device resolution',()=>{
 const s=surface(),buffer=new ChartFrameBuffer(s.container);
 buffer.capture();assert.equal(s.layers.length,0,'do not capture an unpainted first frame');
 buffer.markReady();buffer.capture();
 assert.deepEqual([s.layers[0].width,s.layers[0].height],[1200,400]);
 assert.equal(s.layers[0].style.backgroundColor,'rgb(24, 27, 31)');
 s.source.pixels='';assert.equal(s.visible(),'previous complete frame');
 s.source.pixels='new complete frame';buffer.release();assert.equal(s.visible(),'new complete frame');
 buffer.dispose();assert.equal(s.layers.length,0);
});

test('slow paints are serialized, refresh bursts coalesce, and no blank intermediate frame is displayed',async()=>{
 const s=surface(),buffer=new ChartFrameBuffer(s.container);buffer.markReady();
 const paints=[],pending=[],seen=[];
 const queue=new ChartRefreshQueue({
  before:()=>buffer.capture(),
  render:value=>{paints.push(value);s.source.pixels='';seen.push(s.visible());return new Promise(resolve=>pending.push(()=>{s.source.pixels=`frame ${value}`;resolve();}));},
  committed:()=>buffer.markReady(),idle:success=>{if(success)buffer.release();seen.push(s.visible());},error:err=>assert.fail(String(err)),
 });
 queue.submit(1);queue.submit(2);queue.submit(3);
 assert.deepEqual(paints,[1]);assert.equal(s.visible(),'previous complete frame');
 pending.shift()();await flush();assert.deepEqual(paints,[1,3]);assert.equal(s.visible(),'frame 1');
 pending.shift()();await flush();assert.equal(s.visible(),'frame 3');
 assert.ok(seen.every(frame=>frame.length>0),'never expose the live canvas while it is blank');
 queue.dispose();buffer.dispose();
});

test('a failed render keeps the previous frame and a subsequent successful refresh recovers',async()=>{
 const s=surface(),buffer=new ChartFrameBuffer(s.container);buffer.markReady();
 let fail=true;const errors=[];
 const queue=new ChartRefreshQueue({before:()=>buffer.capture(),render:async value=>{s.source.pixels='';if(fail)throw Error('query chart failed');s.source.pixels=value;},committed:()=>buffer.markReady(),idle:success=>{if(success)buffer.release();},error:err=>errors.push(err.message)});
 queue.submit('bad');await flush();assert.equal(s.visible(),'previous complete frame');assert.deepEqual(errors,['query chart failed']);
 // The failed partial paint is not a completed frame to copy on retry.
 fail=false;queue.submit('recovered');assert.equal(s.visible(),'previous complete frame');await flush();assert.equal(s.visible(),'recovered');
 queue.dispose();buffer.dispose();
});

test('unmount discards queued paints and suppresses callbacks from an in-flight render',async()=>{
 let resolve;const paints=[],callbacks=[];
 const queue=new ChartRefreshQueue({before:()=>{},render:value=>{paints.push(value);return new Promise(done=>{resolve=done;});},committed:()=>callbacks.push('commit'),idle:()=>callbacks.push('idle'),error:()=>callbacks.push('error')});
 queue.submit(1);queue.submit(2);queue.dispose();queue.submit(3);resolve();await flush();
 assert.deepEqual(paints,[1]);assert.deepEqual(callbacks,[]);
});

test('execution timing changes do not invalidate chart rows but data and completeness changes do',()=>{
 const result={refId:'A',status:'success',frames:[{columns:[{name:'value',type:'UInt64'}],rows:[['18446744073709551615'],[null]]}],complete:true,truncated:false,elapsed_ms:1};
 assert.equal(chartDataSignature([result]),chartDataSignature([{...result,elapsed_ms:500}]));
 assert.notEqual(chartDataSignature([result]),chartDataSignature([{...result,truncated:true}]));
 const changed=structuredClone(result);changed.frames[0].rows[0][0]='18446744073709551614';
 assert.notEqual(chartDataSignature([result]),chartDataSignature([changed]));
});

test('unchanged series preserve the hidden selection reference across refreshes',()=>{
 const previous=['api'];assert.equal(retainHiddenSeries(previous,['api','worker']),previous);
 assert.deepEqual(retainHiddenSeries(previous,['worker']),[]);
 const empty=[];assert.equal(retainHiddenSeries(empty,['api']),empty);
});
