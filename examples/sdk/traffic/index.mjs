// Local business-traffic fixture: real HTTP requests instrumented with the SDK.
import {createServer} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {createLightMoni,withTrace} from '../../../sdk/typescript/dist/src/index.js';

const endpoint=process.env.LIGHTMONI_ENDPOINT??'https://monitor.example.com';
const port=Number(process.env.LIGHTMONI_TRAFFIC_PORT??18419);
const durationSeconds=Number(process.env.LIGHTMONI_DURATION_SECONDS??1800);
if(!Number.isInteger(port)||port<1024||port>65535||!Number.isFinite(durationSeconds)||durationSeconds<=0)throw new Error('Invalid traffic port or duration');
const services=['checkout-api','order-api','inventory-worker'];
const clients=services.map(service=>createLightMoni({service,table:'http',endpoint,key:process.env.LIGHTMONI_KEY,intervalMs:1000,resource:{environment:'local','telemetry_source':'sdk-traffic-fixture'}}));
const instruments=clients.map(client=>({requests:client.counter('http.requests',{unit:'{request}'}),duration:client.histogram('http.duration',{unit:'ms',boundaries:[10,25,50,100,250,500]}),active:client.gauge('http.active',{unit:'{request}'})}));
let sequence=0,closing=false,active=0;
const server=createServer(async(req,res)=>{
 const id=++sequence,index=req.url?.includes('orders')?1:req.url?.includes('inventory')?2:0,client=clients[index],meter=instruments[index],route=['/api/payments','/api/orders','/api/inventory'][index];
 const status=id%13===0?500:id%7===0?429:200,region=['cn-east','cn-north','ap-south'][id%3],start=performance.now();active++;
 const span=client.withTable('app').startSpan(`${req.method} ${route}`,{route,method:req.method??'GET'});span.setKind(2);
 try{await withTrace(span.context,async()=>{
  await delay(8+(id*17)%220);
  const duration=Number((performance.now()-start).toFixed(3)),attrs={route,method:req.method??'GET',status,region};
  meter.requests.add(1,attrs);meter.duration.record(duration,attrs);meter.active.record(active);
  if(status>=500)span.setError('upstream timeout');
  client.withTable('app').log(status>=500?'error':status===429?'warn':'info',status>=500?'Payment upstream timed out':status===429?'Request throttled; scheduled for retry':'Request completed',{
   ...attrs,duration_ms:duration,request_id:`req-${String(id).padStart(6,'0')}`,order_id:`order-${Math.floor(id/3)}`,payment_method:['wechat','alipay','card'][id%3],attempt:status===429?2:1
  });
  res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify({request_id:id,status}));
 });}catch(error){res.writeHead(500);res.end(String(error));}finally{span.end();active--;}
});
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve)});
async function request(i){const paths=['payments','orders','inventory'];await fetch(`http://127.0.0.1:${port}/api/${paths[i%3]}`,{method:i%3===0?'POST':'GET'}).then(response=>response.text());}
console.log(`SDK traffic fixture running at 127.0.0.1:${port}; telemetry via ${new URL(endpoint).origin}; duration ${durationSeconds}s`);
let shutdownTask;
function shutdown(){if(shutdownTask)return shutdownTask;closing=true;shutdownTask=(async()=>{await new Promise(resolve=>server.close(resolve));await Promise.all(clients.map(client=>client.shutdown({timeoutMs:15000})));console.log('Traffic fixture stopped:',sequence,'requests');})();return shutdownTask;}
process.once('SIGINT',()=>void shutdown());process.once('SIGTERM',()=>void shutdown());
await Promise.all(Array.from({length:120},(_,i)=>request(i)));
await Promise.all(clients.map(client=>client.flush()));
console.log('Initial traffic delivered:',sequence,'requests');
const started=Date.now();let tick=0;
while(!closing&&Date.now()-started<durationSeconds*1000){await Promise.all(Array.from({length:4},(_,i)=>request(tick*4+i)));tick++;await delay(1000);}
await shutdown();
