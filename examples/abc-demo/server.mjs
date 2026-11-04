import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';

export function createDemoServer({version=process.env.APP_VERSION||'1.0.0',telemetry}={}){
 const started=Date.now();let requests=0,pings=0;
 const requestCount=telemetry?.counter('http.server.requests',{unit:'1'}),duration=telemetry?.histogram('http.server.duration',{unit:'ms'}),uptime=telemetry?.gauge('process.uptime',{unit:'s'});
 const heartbeat=telemetry?setInterval(()=>{uptime.record((Date.now()-started)/1000);telemetry.log('info','abc-demo heartbeat',{event:'heartbeat'})},15000):undefined;heartbeat?.unref();
 const files={'/':['index.html','text/html; charset=utf-8'],'/app.js':['app.js','text/javascript; charset=utf-8'],'/style.css':['style.css','text/css; charset=utf-8']};
 const server=createServer(async(req,res)=>{
  const begin=performance.now(),path=new URL(req.url,'http://localhost').pathname;requests++;
  res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
  res.setHeader('Referrer-Policy','no-referrer');
  const json=(status,value)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(value)+'\n');};
  res.on('finish',()=>{
   const milliseconds=Math.round((performance.now()-begin)*100)/100,attributes={method:req.method,path:path.slice(0,180),status:res.statusCode};
   console.log(JSON.stringify({event:'http_request',service:'abc-demo',...attributes,duration_ms:milliseconds}));
   requestCount?.add(1,attributes);duration?.record(milliseconds,attributes);
   telemetry?.log(res.statusCode>=500?'error':'info','http_request',{...attributes,duration_ms:milliseconds});
  });
  if(req.method==='GET'&&path==='/healthz')return json(200,{status:'ok',service:'abc-demo'});
  if(req.method==='GET'&&path==='/api/status')return json(200,{status:'ok',service:'abc-demo',version,uptime_seconds:Math.floor((Date.now()-started)/1000),requests,pings,time:new Date().toISOString()});
  if(req.method==='POST'&&path==='/api/ping'){
   if(Number(req.headers['content-length']||0)>1024)return json(413,{error:'request_too_large'});
   req.resume();pings++;return json(200,{id:randomUUID(),message:'请求已抵达应用',time:new Date().toISOString()});
  }
  if(req.method==='GET'&&files[path]){
   try{const [name,type]=files[path],data=await readFile(new URL(name,import.meta.url));res.writeHead(200,{'content-type':type,'cache-control':'no-cache'});res.end(data);}
   catch{json(500,{error:'asset_unavailable'});}return;
  }
  return json(404,{error:'not_found'});
 });
 server.once('close',()=>clearInterval(heartbeat));return server;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 let telemetry;
 if(process.env.LIGHTMONI_KEY&&process.env.LIGHTMONI_ENDPOINT){const {createLightMoni}=await import('./sdk/index.js');telemetry=createLightMoni({table:'abc',intervalMs:5000});}
 const port=Number(process.env.PORT||8080),server=createDemoServer({telemetry});server.listen(port,'0.0.0.0',()=>console.log(JSON.stringify({event:'started',service:'abc-demo',port,sdk_configured:!!telemetry})));
 for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>server.close(async()=>{await telemetry?.shutdown({timeoutMs:5000});process.exit(0)}));
}
