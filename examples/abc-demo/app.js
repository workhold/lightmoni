const el=id=>document.getElementById(id);
el('protocol').textContent=location.protocol==='https:'?'HTTPS':'HTTP';
el('domain').textContent=location.hostname;
async function refresh(){
 try{const r=await fetch('/api/status',{cache:'no-store'});if(!r.ok)throw Error();const v=await r.json();
 el('connection').textContent='服务在线';el('connection').classList.remove('failed');el('version').textContent=v.version;
 const s=v.uptime_seconds;el('uptime').textContent=s<60?s+' 秒':s<3600?Math.floor(s/60)+' 分钟':(s/3600).toFixed(1)+' 小时';
 el('requests').textContent=v.requests.toLocaleString('zh-CN');el('updated').textContent='最近更新 '+new Date(v.time).toLocaleTimeString('zh-CN');
 }catch{el('connection').textContent='连接暂不可用';el('connection').classList.add('failed');}
}
el('ping').addEventListener('click',async()=>{const b=el('ping');b.disabled=true;try{const r=await fetch('/api/ping',{method:'POST'});if(!r.ok)throw Error();const v=await r.json();el('receipt').textContent=v.message+' · '+v.id.slice(0,8)+' · '+new Date(v.time).toLocaleTimeString('zh-CN');await refresh();}catch{el('receipt').textContent='请求暂未完成，请稍后再试。';}finally{b.disabled=false;}});
refresh();setInterval(refresh,15000);
