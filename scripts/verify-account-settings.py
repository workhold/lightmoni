"""Account/settings API regression against the disposable local QA instance."""
import base64
import http.cookiejar
import json
import os
from pathlib import Path
import time
import urllib.error
import urllib.request

base = os.environ.get('LIGHTMONI_SETTINGS_QA_URL', 'http://127.0.0.1:18980')
run = os.environ.get('LIGHTMONI_QA_RUN', '1')
assert base.startswith('http://127.0.0.1:'), 'Use a disposable local QA instance'

def client():
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

def call(actor, method, path, body=None, expected=200):
    request = urllib.request.Request(base + '/api/v1' + path, data=json.dumps(body).encode() if body is not None else None, method=method, headers={'Content-Type':'application/json'})
    try:
        response = actor.open(request)
    except urllib.error.HTTPError as error:
        response = error
    data = json.load(response)
    assert response.code == expected, (method, path, response.code, data)
    return data

admin = client()
account = {'name':'settings-qa-admin', 'password':'local-settings-qa-password'}
setup = call(admin, 'GET', '/setup')
call(admin, 'POST', '/setup' if setup['required'] else '/auth/login', account, 201 if setup['required'] else 200)
name = 'settings-member-' + str(time.time_ns())
member = call(admin,'POST','/users', {'name':name,'password':account['password'],'role':'member'},201)
actor = client()
call(actor,'POST','/auth/login',{'name':name,'password':account['password']})
profile = {'nickname':'设置验收 '+run,'phone':'13800000001','avatar_url':'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4u8AAAAASUVORK5CYII='}
call(actor,'PUT','/auth/notification-profile',{'email':'qa@example.com','wecom_id':'qa-member','phone':'13900000002'})
saved = call(actor,'PUT','/auth/profile',{**profile,'id':'unrelated','role':'admin'})
assert saved['phone'] == '+8613800000001'
me = call(actor,'GET','/auth/me')
assert me['role']=='member' and me['name']==name and me['nickname']==profile['nickname']
assert me['avatar_url']==profile['avatar_url']
contact = call(actor,'GET','/auth/notification-profile')
assert contact['email']=='qa@example.com' and contact['wecom_id']=='qa-member' and contact['phone']==saved['phone']
call(actor,'PUT','/auth/profile',{**profile,'phone':'bad'},400)
assert call(actor,'GET','/auth/profile')==saved
call(actor,'POST','/auth/logout')
assert call(actor,'POST','/auth/login',{'name':name,'password':account['password']})['nickname']==profile['nickname']
for method,path,body in [('GET','/users',None),('POST','/users',{}),('GET','/settings/login-providers',None),('PUT','/settings/login-providers/forbidden',{}),('PUT','/assistant/config',{}),('POST','/assistant/models',{}),('PUT','/settings/reporting',{}),('PUT','/settings/retention',{}),('POST','/notify/channels',{}),('PUT','/settings/alert-directory-sources/forbidden',{})]:
    call(actor,method,path,body,403)
config={'base_url':'http://127.0.0.1:1/v1','protocol':'openai-chat-completions','model':'qa-local-model','api_key':'qa-test-key','enabled':False}
call(admin,'PUT','/assistant/config',config)
assert call(admin,'GET','/assistant/config')['has_key']
assert 'api_key' not in call(actor,'GET','/assistant/config')
endpoint = 'http://127.0.0.1:18980'
call(admin,'PUT','/settings/reporting',{'endpoint':endpoint})
assert call(admin,'GET','/settings/reporting')['effective_endpoint']==endpoint
provider_id='settings-qa-provider-'+run
call(admin,'PUT','/settings/login-providers/'+provider_id,{'kind':'github','name':'GitHub QA','client_id':'qa-client','client_secret':'qa-secret','enabled':True,'auto_approve':False})
providers=call(admin,'GET','/settings/login-providers')
assert any(p['id']==provider_id for p in providers) and all(not p.get('client_secret') for p in providers)
assert any(p['id']==provider_id for p in call(actor,'GET','/auth/providers'))
disabled_name='disabled-'+name
disabled=call(admin,'POST','/users',{'name':disabled_name,'password':account['password'],'role':'member','active':False},201)
call(client(),'POST','/auth/login',{'name':disabled_name,'password':account['password']},401)
call(admin,'PUT','/users/'+disabled['id'],{'name':disabled_name,'role':'member','active':True})
call(client(),'POST','/auth/login',{'name':disabled_name,'password':account['password']})
rows=call(admin,'GET','/users')
assert any(row['id']==member['id'] and row['nickname']==profile['nickname'] for row in rows)
report={'run':run,'passed':True,'checks':['个人资料保存、重新登录与读回','手机号与通知资料共用记录，保留其他联系方式','非法输入不改变已保存资料','成员访问管理接口被拒绝，不能修改身份或角色','模型配置、上报地址与第三方登录真实保存','第三方密钥不会出现在读取结果','创建禁用用户与重新启用生效']}
output=Path(__file__).resolve().parent.parent/'docs/evidence/account-settings'
output.mkdir(parents=True,exist_ok=True)
(output/('api-'+run+'.json')).write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(report,ensure_ascii=False))
