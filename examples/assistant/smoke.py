#!/usr/bin/env python3
"""Local model protocol fixture, real catalog/ClickHouse tool execution. Not an AI quality test."""
import argparse,datetime,http.cookiejar,json,threading,urllib.request
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer

parser=argparse.ArgumentParser();parser.add_argument('--url',default='http://127.0.0.1:18380');args=parser.parse_args()
now=datetime.datetime.now(datetime.timezone.utc)
query={'sql':'SELECT service, count() AS events FROM log_app WHERE $__timeFilter(event_time) GROUP BY service ORDER BY events DESC','range':{'from':(now-datetime.timedelta(hours=2)).isoformat(),'to':now.isoformat()},'interval_ms':60000}
draft={'title':'AI 协议验收草稿','description':'Local fixture; real ClickHouse data','panels':[{'title':'服务日志数量','type':'bar','queries':[{'refId':'A','sql':query['sql']}],'options':{'x':'service','y':'events'},'grid':{'x':0,'y':0,'w':12,'h':6}}]}
class Provider(BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_POST(self):
  body=json.loads(self.rfile.read(int(self.headers['Content-Length'])));stage=sum(m['role']=='tool' for m in body['messages']);tools=[('list_tables',{}),('run_query',query),('draft_dashboard',draft)]
  self.send_response(200);self.send_header('Content-Type','text/event-stream');self.end_headers()
  if stage<len(tools):
   name,arguments=tools[stage];delta={'tool_calls':[{'index':0,'id':'fixture-'+str(stage),'type':'function','function':{'name':name,'arguments':json.dumps(arguments)}}]};finish='tool_calls'
  else:delta={'content':'本地协议测试已读取真实目录、执行 SQL 并生成待审阅大盘。此文本来自 fixture。'};finish='stop'
  for value in [{'choices':[{'delta':delta,'finish_reason':None}]},{'choices':[{'delta':{},'finish_reason':finish}]}]:self.wfile.write(('data: '+json.dumps(value,ensure_ascii=False)+'\n\n').encode())
  self.wfile.write(b'data: [DONE]\n\n');self.wfile.flush()
server=ThreadingHTTPServer(('127.0.0.1',0),Provider);threading.Thread(target=server.serve_forever,daemon=True).start()
jar=http.cookiejar.CookieJar();client=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
def request(path,body=None,method=None,stream=False):
 data=None if body is None else json.dumps(body).encode();req=urllib.request.Request(args.url+'/api/v1'+path,data,{'Content-Type':'application/json'},method=method)
 with client.open(req,timeout=60) as response:return response.read().decode() if stream else json.load(response)
request('/auth/login',{'name':'local-admin','password':'local-demo-password'})
previous=request('/assistant/config');assert not previous['has_key'] and not previous['enabled'],'Run fixture only on the isolated acceptance instance with no real provider configured.'
# A Docker main service reaches the host fixture using host.docker.internal.
host='host.docker.internal' if args.url.endswith(':18380') else '127.0.0.1'
try:
 request('/assistant/config',{'base_url':f'http://{host}:{server.server_port}/v1','model':'local-fixture','enabled':True},'PUT')
 before=request('/dashboards');session=request('/assistant/sessions',{'title':'Fixture tool-loop acceptance'})
 stream=request('/assistant/sessions/'+session['id']+'/turns',{'text':'执行本地测试工具链，生成大盘草稿。'},stream=True)
 saved=request('/assistant/sessions/'+session['id']);assert request('/dashboards')==before,'Model silently saved dashboard'
 events=saved['events'];assert any(e['type']=='turn.completed' for e in events),stream
 outputs=[e for e in events if e['type']=='tool.result'];assert len(outputs)==3,events
 assert any('draft' in json.dumps(e['data']) for e in outputs),outputs
 assert 'smoke-' in json.dumps(outputs),'Query did not analyze real SDK data'
 print(json.dumps({'status':'passed','fixture':True,'session_id':session['id'],'tools':['list_tables','run_query','draft_dashboard'],'dashboard_saved_automatically':False,'real_ai_provider':'not tested'},ensure_ascii=False,indent=2))
finally:
 request('/assistant/config',{'base_url':previous.get('base_url') or 'http://127.0.0.1:1/v1','model':previous.get('model') or 'disabled-fixture','enabled':False},'PUT');server.shutdown()
