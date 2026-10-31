import http from 'node:http';
import net from 'node:net';
import {readFile} from 'node:fs/promises';
const target=process.env.DEMO_HOST || 'lightmoni-qa-host';
async function entryTarget(){
  if(process.env.DEMO_STATE)try{return JSON.parse(await readFile(process.env.DEMO_STATE+'/entry.json','utf8')).address;}catch{}
  return target;
}
for(const [port,domain] of [[8080,'demo.example.test'],[8081,'admin.example.test']]) {
  http.createServer(async(req,res)=>{
    const upstream=http.request({host:await entryTarget(),port:80,path:req.url,method:req.method,headers:{...req.headers,host:domain}},response=>{
      res.writeHead(response.statusCode,response.headers);response.pipe(res);
    });
    upstream.on('error',()=>{res.writeHead(503);res.end('Demo OpenResty is not ready');});
    req.pipe(upstream);
  }).listen(port,'0.0.0.0');
}
net.createServer(async client=>{
  const upstream=net.connect(443,await entryTarget());
  client.on('error',()=>upstream.destroy());upstream.on('error',()=>client.destroy());
  client.pipe(upstream);upstream.pipe(client);
}).listen(8443,'0.0.0.0');
if(process.env.DEMO_STATE){
  const token=(await readFile(process.env.DEMO_STATE+'/qa.token','utf8')).trim();
  http.createServer((req,res)=>{
    const headers={...req.headers};
    // Only this explicit loopback entry point obtains a real QA admin session.
    // Subsequent API requests carry the production HttpOnly session cookie.
    if(req.url==='/qa/workbench')headers.authorization='Bearer '+token;
    const upstream=http.request({host:target,port:19042,path:req.url,method:req.method,headers},response=>{res.writeHead(response.statusCode,response.headers);response.pipe(res);});
    upstream.on('error',()=>{res.writeHead(503);res.end('QA control plane is not ready');});req.pipe(upstream);
  }).listen(8090,'0.0.0.0');
}
