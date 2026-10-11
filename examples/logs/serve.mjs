// Serve a fixed Vite build for browser acceptance while other agents edit the app.
import http from 'node:http';
import {readFileSync,existsSync} from 'node:fs';
import path from 'node:path';
const dir=path.resolve(process.argv[2]??'/tmp/lightmoni-logs-qa');
const port=Number(process.env.LIGHTMONI_LOGS_QA_PORT??15173);
const upstream=new URL(process.env.LIGHTMONI_TEST_URL??'http://127.0.0.1:18880');
http.createServer((req,res)=>{
 if(req.url.startsWith('/api/')){if(req.headers.origin&&req.headers.origin!==`http://127.0.0.1:${port}`){res.writeHead(403);res.end('Invalid QA origin');return}const headers={...req.headers,host:upstream.host};if(req.headers.origin)headers.origin=process.env.LIGHTMONI_LOGS_QA_ORIGIN??'http://127.0.0.1:5173';const proxied=http.request(new URL(req.url,upstream),{method:req.method,headers},reply=>{res.writeHead(reply.statusCode,reply.headers);reply.pipe(res)});proxied.on('error',()=>{res.writeHead(502);res.end('Upstream unavailable')});req.pipe(proxied);return}
 const requested=path.resolve(dir,'.'+decodeURIComponent(req.url.split('?')[0]));
 const file=requested.startsWith(dir+path.sep)&&existsSync(requested)?requested:path.join(dir,'index.html');
 try{const mime={'.js':'text/javascript','.css':'text/css','.html':'text/html','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2','.json':'application/json','.wasm':'application/wasm'}[path.extname(file)]??'application/octet-stream';res.writeHead(200,{'Content-Type':mime});res.end(readFileSync(file))}catch{res.writeHead(404);res.end('Not found')}
}).listen(port,'127.0.0.1',()=>console.log(`Fixed logs QA UI: http://127.0.0.1:${port}`));
