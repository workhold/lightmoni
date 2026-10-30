import { createServer } from 'node:http';
import { hostname } from 'node:os';
import mysql from 'mysql2/promise';

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'host.docker.internal',
  port: Number(process.env.DB_PORT || 23306),
  user: process.env.DB_USER || 'demo',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'cluster_demo',
  connectionLimit: 4,
  connectTimeout: 3000,
});
let initialized = false;
const instance = hostname();
const version = '1.0.0';
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LightMoni 集群应用 Demo</title><style>
:root{font-family:system-ui,-apple-system,sans-serif;color:#183128;background:#f2f5f1}body{margin:0}main{max-width:760px;margin:60px auto;padding:28px}small{color:#517364;letter-spacing:.12em}h1{font-size:36px;margin:12px 0}p{line-height:1.8;color:#52675a}.card{background:white;border:1px solid #dde5dd;border-radius:16px;padding:24px;margin-top:24px;box-shadow:0 8px 24px #203c2310}.flow{font-size:14px;font-family:monospace;padding:14px;background:#e9f0e9;border-radius:8px}form{display:flex;gap:10px;margin:20px 0}input{min-width:0;flex:1;padding:12px;border:1px solid #bdccbf;border-radius:8px;font:inherit}button{padding:12px 20px;background:#275d42;color:white;border:0;border-radius:8px;font:inherit;cursor:pointer}li{padding:14px 0;border-bottom:1px solid #edf1eb;list-style:none}ul{padding:0}.meta{font-size:12px;color:#6e8071;margin-top:6px}#status{min-height:24px;font-size:14px;color:#356c4b}@media(max-width:600px){main{margin:20px auto;padding:20px}h1{font-size:28px}form{flex-direction:column}}
</style><main><small>LIGHTMONI · LIVE DEMO</small><h1>集群里的留言板</h1><p>每条留言真实写入 MySQL。应用重新部署后，数据依然保留。</p><div class="flow">OpenResty → 自定义 Web :8080 → MySQL :3306</div><section class="card"><h2>写一条留言</h2><form id="form"><input id="message" aria-label="留言内容" required maxlength="240" placeholder="例如：集群应用部署成功"><button>保存到数据库</button></form><div id="status" role="status"></div><ul id="messages"></ul><div class="meta" id="instance"></div></section></main><script>
const status=document.querySelector('#status');
async function refresh(){const res=await fetch('/api/messages');const data=await res.json();if(!res.ok)throw Error('数据库暂时不可用');const list=document.querySelector('#messages');list.replaceChildren();for(const item of data.messages){const li=document.createElement('li');const text=document.createElement('div');text.textContent=item.message;const meta=document.createElement('div');meta.className='meta';meta.textContent='#'+item.id+' · '+new Date(item.created_at).toLocaleString();li.append(text,meta);list.append(li)}document.querySelector('#instance').textContent='实例 '+data.instance+' · 版本 '+data.version+' · 共 '+data.messages.length+' 条';}
document.querySelector('#form').addEventListener('submit',async e=>{e.preventDefault();try{const res=await fetch('/api/messages',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:document.querySelector('#message').value})});if(!res.ok)throw Error('写入失败');document.querySelector('#message').value='';await refresh();status.textContent='已写入 MySQL';}catch(err){status.textContent=err.message;}});refresh().catch(err=>status.textContent=err.message);
</script></html>`;

function json(res, status, body) {
  res.writeHead(status, {'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
  res.end(JSON.stringify(body));
}
async function handler(req, res, admin) {
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/healthz') {
      await pool.query('SELECT 1');
      return json(res, initialized ? 200 : 503, {healthy:initialized,instance,port:admin?'admin':'http',version});
    }
    if (!initialized) return json(res, 503, {error:'database_initializing'});
    if (admin) {
      const [rows] = await pool.query('SELECT COUNT(*) AS count FROM messages');
      return json(res, 200, {service:'cluster-demo-admin',port:'admin',instance,version,messages:Number(rows[0].count)});
    }
    if (pathname === '/api/messages' && req.method === 'GET') {
      const [messages] = await pool.query('SELECT id,message,created_at FROM messages ORDER BY id DESC LIMIT 100');
      return json(res, 200, {messages,instance,version});
    }
    if (pathname === '/api/messages' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) {body+=chunk;if(Buffer.byteLength(body)>2048)return json(res,413,{error:'too_large'});}
      let input;try{input=JSON.parse(body)}catch{return json(res,400,{error:'invalid_json'})}
      const message=typeof input.message==='string'?input.message.trim():'';
      if(!message || message.length>240)return json(res,400,{error:'invalid_message'});
      const [result]=await pool.execute('INSERT INTO messages(message) VALUES(?)',[message]);
      return json(res,201,{id:result.insertId,message,instance,version});
    }
    if(pathname==='/' && req.method==='GET'){res.writeHead(200,{'content-type':'text/html; charset=utf-8'});return res.end(html);}
    return json(res,404,{error:'not_found'});
  } catch {json(res,503,{error:'database_unavailable'});}
}
for(const [port,admin] of [[8080,false],[9090,true]])createServer((req,res)=>handler(req,res,admin)).listen(port,'0.0.0.0');
for(let attempt=0;attempt<120;attempt++) {
  try {
    await pool.query('CREATE TABLE IF NOT EXISTS messages(id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,message VARCHAR(240) NOT NULL,created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)');
    initialized=true;console.info('Demo listening on named ports http:8080 and admin:9090');break;
  } catch {await new Promise(resolve=>setTimeout(resolve,1000));}
}
if(!initialized){console.error('Database initialization did not become ready');process.exitCode=1;}
