import type {ReportingAddress} from './reporting-addresses';
export type SDKConnectionMode='agent'|'direct';
export const SDK_AGENT_ENDPOINT='http://127.0.0.1:4318';

export function sdkSampleFor(language:string,mode:SDKConnectionMode='direct',endpoint?:string):string {
  const examples:Record<string,string>={
    typescript:`import {createLightMoniFromEnv} from '@lightmoni/sdk';

const moni = createLightMoniFromEnv({service:'order-api', table:'business'});
await moni.withSpan('create_order', async () => {
  moni.counter('orders_created').add(1, {region:'cn'});
  moni.log('info', 'order created', {order_id:'123'});
});
await moni.shutdown({timeoutMs:5000});`,
    python:`from lightmoni import Client

moni = Client.from_env("order-api", "business")
moni.counter("orders_created").add(1, {"region":"cn"})
with moni.start_span("create_order"):
    moni.log("info", "order created", {"order_id":"123"})
moni.shutdown(timeout=5)`,
    ruby:`require 'lightmoni'

moni = LightMoni.from_env(service:'order-api', table:'business')
moni.counter('orders_created').add(1, 'region'=>'cn')
moni.with_span('create_order') do
  moni.log('info', 'order created', 'order_id'=>'123')
end
moni.shutdown(timeout:5)`,
  };
  return examples[language]??examples.typescript;
}

export function sdkEndpointError(endpoint:string):string {
  try {
    const value=endpoint.trim();
    if(!/^https?:\/\//i.test(value)||/[?#\\\s]/.test(value))throw new Error();
    const url=new URL(value);
    if(!['http:','https:'].includes(url.protocol)||!url.hostname||url.username||url.password||url.search||url.hash)throw new Error();
    return '';
  } catch { return '请输入完整的 HTTP(S) 地址，不包含用户名、密码、查询参数或片段'; }
}
export function sdkEndpointIsLoopback(endpoint:string):boolean {
  try {const hostname=new URL(endpoint.trim()).hostname.toLowerCase();return hostname==='localhost'||hostname.endsWith('.localhost')||/^127\./.test(hostname)||hostname==='[::1]';}catch{return false;}
}
export function sdkEnvironment(mode:SDKConnectionMode,endpoint:string):string {
  const quote=(value:string)=>"'"+value.replaceAll("'", "'\\''")+"'";
  const base=endpoint.trim().replace(/\/+$/,'');
  const reset=mode==='direct'
    ?'unset LIGHTMONI_AGENT_ENDPOINT LIGHTMONI_LOCAL_TOKEN LIGHTMONI_LOCAL_TOKEN_FILE LIGHTMONI_DATA_KEY_FILE LIGHTMONI_KEY'
    :'unset LIGHTMONI_ENDPOINT LIGHTMONI_DATA_KEY LIGHTMONI_DATA_KEY_FILE LIGHTMONI_KEY LIGHTMONI_LOCAL_TOKEN LIGHTMONI_LOCAL_TOKEN_FILE';
  return `${reset}\nexport LIGHTMONI_MODE=${mode}\n`+(mode==='direct'
    ?`export LIGHTMONI_ENDPOINT=${quote(base)}\nexport LIGHTMONI_DATA_KEY='替换为允许 business 表的上报 Key'`
    :`export LIGHTMONI_AGENT_ENDPOINT=${quote(base || SDK_AGENT_ENDPOINT)}\n# 仅在 Agent 启用本地鉴权时配置；未启用时无需设置。\n# export LIGHTMONI_LOCAL_TOKEN='替换为 Agent 本地访问令牌'`);
}

export interface SDKPackage {id:string;language:string;runtime:string;file:string;url:string;available:boolean}
export interface SDKDeferred {id:string;language:string;runtime:string;status:'deferred';reason:string}
export interface SDKInstall {endpoint?:string;endpoints?:ReportingAddress[];default_endpoint_id?:string;version:string;node_url:string;packages:SDKPackage[];deferred?:SDKDeferred[];checksums_url:string}
export const sdkExamples:Record<string,{language:string;install:string;sample:string}> = {
  typescript:{
    language:'typescript',
    install:'npm install ./lightmoni-sdk-0.1.0.tgz',
    sample:sdkSampleFor('typescript'),
  },
  python:{
    language:'python',
    install:'tar -xzf lightmoni-python-sdk_0.1.0.tar.gz\npython3 -m pip install ./lightmoni-python-sdk/sdk/python',
    sample:sdkSampleFor('python'),
  },
  ruby:{
    language:'ruby',
    install:'tar -xzf lightmoni-ruby-sdk_0.1.0.tar.gz\ncd lightmoni-ruby-sdk/sdk/ruby\ngem build lightmoni.gemspec\ngem install ./lightmoni-sdk-0.1.0.gem',
    sample:sdkSampleFor('ruby'),
  },
};
