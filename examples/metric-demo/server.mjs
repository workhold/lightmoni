import{createServer}from'node:http';import{setTimeout as delay}from'node:timers/promises';import{writeFile}from'node:fs/promises';import{createLightMoni}from'../../sdk/typescript/dist/src/index.js';import{readState,statePath}from'./common.mjs';
const state=await readState(),port=Number(process.env.LIGHTMONI_DEMO_PORT??18481),host=process.env.LIGHTMONI_DEMO_HOST??'127.0.0.1';
let mode='normal',sequence=0,closing=false;const counters={requests:0,spend_people:0,spend_total:0,invalid:0},receipts=[];
const clients=['a','b'].map(id=>createLightMoni({service:'metric-demo',env:'demo',service_version:'1.0.0',instance_id:'demo-'+id,endpoint:state.endpoint,key:state.key,configIntervalMs:5000}));
async function request(client,index){const id=++sequence,slow=mode==='slow',duration=slow?750+id%150:8+id%32;const start=performance.now();await delay(duration);client.record(state.table,'db.query.duration_ms',{key1:'mysql',key2:id%2?'select':'update',key3:slow?'slow':'ok'},performance.now()-start,1);client.record(state.table,'http.requests',{key1:index?'west':'east',key2:slow?'error':'success'},1,1);counters.requests++;if(id%20===0){client.record(state.table,'restaurant.spend',{key1:'store-a'},100,5);counters.spend_people+=5;counters.spend_total+=100;}}
const timer=setInterval(()=>{if(!closing)clients.forEach((c,i)=>void request(c,i).catch(()=>counters.invalid++));},200);
const server=createServer(async(req,res)=>{let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>65536){res.writeHead(413).end();return;}}const path=new URL(req.url,'http://localhost').pathname;res.setHeader('content-type','application/json');
 if(req.method==='POST'&&path==='/mode'){let value;try{value=JSON.parse(raw).mode;}catch{}if(!['normal','slow'].includes(value)){res.writeHead(400).end(JSON.stringify({error:'mode must be normal or slow'}));return;}mode=value;}
 else if(req.method==='POST'&&path==='/hook'){receipts.push({at:new Date().toISOString(),body:JSON.parse(raw)});if(receipts.length>100)receipts.shift();await writeFile(statePath+'.receipts.json',JSON.stringify(receipts,null,2),{mode:0o600});}
 else if(path!=='/status'&&path!=='/healthz'){res.writeHead(404).end('{}');return;}
 res.end(JSON.stringify({mode,...counters,receipts:receipts.length,instances:clients.map(c=>c.stats()),dashboard:state.endpoint+'/dashboards/'+state.dashboard_id}));});
server.listen(port,host,()=>console.log('SDK metric demo listening on '+host+':'+port));
async function stop(){if(closing)return;closing=true;clearInterval(timer);await delay(1100);await Promise.all(clients.map(c=>c.shutdown({timeoutMs:10000})));server.close();}
process.once('SIGTERM',()=>void stop());process.once('SIGINT',()=>void stop());
