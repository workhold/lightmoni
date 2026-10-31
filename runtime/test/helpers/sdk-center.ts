/** Isolated center OTLP protocol sink; does not instantiate or use an Agent. */
import {createServer} from 'node:http';
import {createInterface} from 'node:readline';
import {decodeOTLP,encodeOTLP,resources,resourceString,type Signal} from '../../src/shared/otlp.js';
const [,listen='127.0.0.1:0']=process.argv.slice(2),batches:any[]=[];
const split=listen.lastIndexOf(':');
const server=createServer(async(req,res)=>{
 const signal=req.url?.slice(4) as Signal;
 if(req.method!=='POST'||!['logs','metrics','traces'].includes(signal)){res.writeHead(404);res.end();return;}
 const chunks:Buffer[]=[];for await(const c of req)chunks.push(Buffer.from(c));
 const message=decodeOTLP(signal,Buffer.concat(chunks),String(req.headers['content-type']??'application/x-protobuf'));
 const payload=encodeOTLP(signal,message,'application/x-protobuf');
 batches.push({signal,service:resourceString(resources(signal,message)[0],'service.name'),payload:payload.toString('base64'),table:req.headers['x-lightmoni-table']});
 res.writeHead(200,{'content-type':'application/json'});res.end('{}');
});
await new Promise<void>(resolve=>server.listen(Number(listen.slice(split+1)),listen.slice(0,split),resolve));
process.stdout.write(JSON.stringify({url:'http://127.0.0.1:'+(server.address() as any).port})+'\n');
const input=createInterface({input:process.stdin});for await(const command of input){if(command==='stop')break;}
input.close();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));
process.stdout.write(JSON.stringify({batches})+'\n');
