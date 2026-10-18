import type {ReportingAddress} from './reporting-addresses';
export type SDKConnectionMode='agent'|'direct';
export const SDK_AGENT_ENDPOINT='http://127.0.0.1:4318';

export function sdkSampleFor(language:string,mode:SDKConnectionMode='agent',endpoint?:string):string {
  const examples:Record<string,string>={
    typescript:`import {createLightMoniFromEnv} from '@lightmoni/sdk';

const moni = createLightMoniFromEnv({service:'order-api', table:'business'});
await moni.withSpan('create_order', async () => {
  moni.counter('orders_created').add(1, {region:'cn'});
  moni.log('info', 'order created', {order_id:'123'});
});
await moni.shutdown({timeoutMs:5000});`,
    go:`import (
  "context"
  "time"
  moni "github.com/lightmoni/lightmoni/sdk/go"
)

client, err := moni.NewFromEnv("order-api", "business", moni.Config{})
if err != nil { panic(err) }
orders, err := client.Counter("orders_created", moni.MetricOptions{})
if err != nil { panic(err) }
requestCtx, span := client.StartSpan(context.Background(), "create_order")
orders.Add(requestCtx, 1, moni.Attributes{"region":"cn"})
client.Logger(requestCtx).Log("info", "order created", nil)
span.End()
ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
defer cancel()
if err := client.Shutdown(ctx); err != nil { panic(err) }`,
    python:`from lightmoni import Client

moni = Client.from_env("order-api", "business")
moni.counter("orders_created").add(1, {"region":"cn"})
with moni.start_span("create_order"):
    moni.log("info", "order created", {"order_id":"123"})
moni.shutdown(timeout=5)`,
    php:`require './lightmoni-php-sdk/sdk/php/src/Client.php';

$moni = \\LightMoni\\Client::fromEnv('order-api', 'business');
$moni->counter('orders_created')->add(1, ['region'=>'cn']);
$moni->withSpan('create_order', function() use ($moni) {
  $moni->log('info', 'order created', ['order_id'=>'123']);
});
$moni->shutdown(5);`,
    ruby:`require 'lightmoni'

moni = LightMoni.from_env(service:'order-api', table:'business')
moni.counter('orders_created').add(1, 'region'=>'cn')
moni.with_span('create_order') do
  moni.log('info', 'order created', 'order_id'=>'123')
end
moni.shutdown(timeout:5)`,
    rust:`use lightmoni::{Client, Attributes};
use std::time::Duration;

let moni = Client::from_env("order-api", "business")?;
moni.counter("orders_created")?.add(1,
  &Attributes::from([("region".into(), "cn".into())]));
moni.with_span("create_order", &Attributes::new(), None, |scoped, _| {
  scoped.log("info", "order created", &Attributes::new(), None);
})?;
moni.shutdown(Duration::from_secs(5))?;`,
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
  return `export LIGHTMONI_MODE=${mode}\n`+(mode==='direct'?`export LIGHTMONI_ENDPOINT=${quote(base)}\nexport LIGHTMONI_DATA_KEY='替换为允许 business 表的上报 Key'\nunset LIGHTMONI_AGENT_ENDPOINT LIGHTMONI_LOCAL_TOKEN`:`export LIGHTMONI_AGENT_ENDPOINT=${quote(base || SDK_AGENT_ENDPOINT)}\nunset LIGHTMONI_ENDPOINT LIGHTMONI_DATA_KEY\nexport LIGHTMONI_LOCAL_TOKEN='执行节点本地访问令牌（如已启用）'`);
}

export interface SDKPackage {id:string;language:string;runtime:string;file:string;url:string;available:boolean}
export interface SDKInstall {endpoint?:string;endpoints?:ReportingAddress[];default_endpoint_id?:string;version:string;node_url:string;go_url:string;packages:SDKPackage[];checksums_url:string}
export const sdkExamples:Record<string,{language:string;install:string;sample:string}> = {
  typescript:{
    language:'typescript',
    install:'npm install ./lightmoni-sdk-0.1.0.tgz',
    sample:sdkSampleFor('typescript'),
  },
  go:{
    language:'go',
    install:'tar -xzf lightmoni-go-sdk_0.1.0.tar.gz\ngo mod edit -replace github.com/lightmoni/lightmoni=./lightmoni-go-sdk\ngo get github.com/lightmoni/lightmoni/sdk/go\ngo mod tidy',
    sample:sdkSampleFor('go'),
  },
  python:{
    language:'python',
    install:'tar -xzf lightmoni-python-sdk_0.1.0.tar.gz\npython3 -m pip install ./lightmoni-python-sdk/sdk/python',
    sample:sdkSampleFor('python'),
  },
  php:{
    language:'php',
    install:'tar -xzf lightmoni-php-sdk_0.1.0.tar.gz\n# 直接 require 源码，或通过 composer.json 配置 path repository。',
    sample:sdkSampleFor('php'),
  },
  ruby:{
    language:'ruby',
    install:'tar -xzf lightmoni-ruby-sdk_0.1.0.tar.gz\ncd lightmoni-ruby-sdk/sdk/ruby\ngem build lightmoni.gemspec\ngem install ./lightmoni-sdk-0.1.0.gem',
    sample:sdkSampleFor('ruby'),
  },
  rust:{
    language:'rust',
    install:'tar -xzf lightmoni-rust-sdk_0.1.0.tar.gz\n# Cargo.toml [dependencies]\n# lightmoni = { path = "./lightmoni-rust-sdk/sdk/rust" }',
    sample:sdkSampleFor('rust'),
  },
};
