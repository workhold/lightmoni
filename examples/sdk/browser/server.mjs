import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../../..');
const configIndex=process.argv.indexOf('--config');
const config=configIndex<0?{}:JSON.parse(await readFile(process.argv[configIndex+1],'utf8'));
const endpoint=process.env.LIGHTMONI_ENDPOINT??config.endpoint??'http://127.0.0.1:18880';
const key=process.env.LIGHTMONI_KEY??config.key;
if(!key)throw new Error('Provide LIGHTMONI_KEY or --config with a global key; the key stays on this server.');
const port=Number(process.env.PORT??18418);
const signals=new Set(['/v1/logs','/v1/metrics','/v1/traces']);
let minute=0,requests=0;
http.createServer(async(req,res)=>{
 try{
  const path=new URL(req.url,'http://localhost').pathname;
  if(req.method==='GET'&&path==='/v1/sdk-config'){
   const origin=req.headers.origin;if(origin&&origin!==`http://${req.headers.host}`){res.writeHead(403).end('Invalid origin');return;}
   const response=await fetch(endpoint.replace(/\/$/,'')+path,{headers:{Authorization:`Bearer ${key}`},signal:AbortSignal.timeout(5000),redirect:'error'});
   res.writeHead(response.status,{'Content-Type':'application/json','Cache-Control':'no-store'}).end(Buffer.from(await response.arrayBuffer()));return;
  }
  if(req.method==='POST'&&signals.has(path)){
   const current=Math.floor(Date.now()/60000);if(current!==minute){minute=current;requests=0;}
   if(++requests>120){res.writeHead(429,{'Retry-After':'5'}).end();return;}
   const origin=req.headers.origin;
   if(origin&&origin!==`http://${req.headers.host}`){res.writeHead(403).end('Invalid origin');return;}
   let length=0;const chunks=[];for await(const chunk of req){length+=chunk.length;if(length>4*1024*1024){res.writeHead(413).end();return;}chunks.push(chunk);}
   const headers={'Content-Type':req.headers['content-type']??'application/json','Authorization':`Bearer ${key}`};
   for(const name of ['x-lightmoni-table','x-lightmoni-batch-id','x-lightmoni-batch-created-at','content-encoding'])if(req.headers[name])headers[name]=req.headers[name];
   const response=await fetch(endpoint.replace(/\/$/,'')+path,{method:'POST',headers,body:Buffer.concat(chunks),signal:AbortSignal.timeout(15000)});
   res.writeHead(response.status,{'Content-Type':response.headers.get('content-type')??'application/json'}).end(Buffer.from(await response.arrayBuffer()));return;
  }
  if(req.method!=='GET'){res.writeHead(405).end();return;}
  const file=path==='/'?'examples/sdk/browser/index.html':decodeURIComponent(path).replace(/^\//,'');
  if(file!=='examples/sdk/browser/index.html'&&!/^sdk\/typescript\/dist\/src\/[a-z-]+\.js$/.test(file)){res.writeHead(404).end();return;}
  const content=await readFile(resolve(root,file));res.writeHead(200,{'Content-Type':file.endsWith('.js')?'text/javascript':'text/html','Cache-Control':'no-store'}).end(content);
 }catch(error){res.writeHead(502,{'Content-Type':'application/json'}).end(JSON.stringify({error:error.message}));}
}).listen(port,'127.0.0.1',()=>console.log(`Browser SDK demo: http://127.0.0.1:${port}. Global key is held by the demo backend.`));
