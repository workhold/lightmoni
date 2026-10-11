#!/usr/bin/env python3
import json, os, subprocess, urllib.request, http.cookiejar
base=os.environ.get('LIGHTMONI_TEST_URL','http://127.0.0.1:18880')
endpoint=os.environ.get('LIGHTMONI_TEST_ENDPOINT',base)
cookie=http.cookiejar.CookieJar(); client=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cookie))
def request(path,body=None):
    raw=None if body is None else json.dumps(body).encode()
    req=urllib.request.Request(base+'/api/v1'+path,raw,{'Content-Type':'application/json'})
    with client.open(req,timeout=30) as r: return json.load(r)
if request('/setup')['required']: request('/setup',{'name':'local-admin','password':'local-demo-password'})
else: request('/auth/login',{'name':'local-admin','password':'local-demo-password'})
if endpoint==base: key=request('/keys',{'name':'acceptance-scoped','allowed_tables':['http','app']})
else:
    import sqlite3,hashlib
    token=json.load(open('.lightmoni/agent-smoke.json'))['key']
    with sqlite3.connect('.lightmoni/lightmoni.db') as db:
        row=db.execute('SELECT id FROM ingest_keys WHERE token_hash=?',(hashlib.sha256(token.encode()).hexdigest(),)).fetchone()
    assert row,'Agent key not found';key={'id':row[0],'key':token}
os.makedirs('.lightmoni',exist_ok=True)
with open('.lightmoni/demo-key','w') as f: f.write(key['key'])
os.chmod('.lightmoni/demo-key',0o600)
env=dict(os.environ,LIGHTMONI_KEY=key['key'],LIGHTMONI_ENDPOINT=endpoint,LIGHTMONI_SERVICE='smoke-'+key['id'][:8]+'-'+__import__('uuid').uuid4().hex[:8])
for command in [['go','run','./examples/sdk/go','-count','20'],['node','examples/sdk/node/index.mjs']]:
    env['LIGHTMONI_SERVICE']=env['LIGHTMONI_SERVICE'][:23]+('-go' if command[0]=='go' else '-node')
    subprocess.run(command,env=env,check=True)
tables=request('/catalog/tables')
from datetime import datetime,timezone,timedelta
now=datetime.now(timezone.utc)
query_body={'request_id':'smoke','range':{'from':(now-timedelta(hours=1)).isoformat(),'to':(now+timedelta(minutes=1)).isoformat()},'interval_ms':60000,'queries':[{'refId':'counts','sql':"SELECT service,key_id,sum(value) AS requests FROM metric_http_sum WHERE $__timeFilter(event_time) AND key_id={key:String} AND startsWith(service,{prefix:String}) GROUP BY service,key_id",'params':{'key':{'type':'String','value':key['id']},'prefix':{'type':'String','value':env['LIGHTMONI_SERVICE'][:23]}}},{'refId':'links','sql':"SELECT l.service,count() AS linked FROM log_app l JOIN trace_app t ON l.trace_id=t.trace_id AND l.span_id=t.span_id WHERE l.key_id={key:String} AND startsWith(l.service,{prefix:String}) GROUP BY l.service",'params':{'key':{'type':'String','value':key['id']},'prefix':{'type':'String','value':env['LIGHTMONI_SERVICE'][:23]}}}]}
import time
for attempt in range(30):
    query=request('/query',query_body)
    if all(r['status']=='success' and len(r['frames'][0]['rows'])==2 for r in query['results']):break
    time.sleep(1)

for result in query['results']:
    assert result['status']=='success',result
    rows=result['frames'][0]['rows'];assert len(rows)==2,rows
    from decimal import Decimal
    assert all(Decimal(str(row[-1]))==20 for row in rows),rows
print('PASS table-scoped Key: Go+Node, 20 requests per service, matching logs/traces, typed SQL frames; tables:',','.join(t['name'] for t in tables))
