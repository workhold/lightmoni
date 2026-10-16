import type {ReportingAddress} from './reporting-addresses';
export type SDKConnectionMode='agent'|'direct';
export const SDK_AGENT_ENDPOINT='http://127.0.0.1:4318';

export function sdkSampleFor(language:string,mode:SDKConnectionMode='agent',endpoint?:string):string {
  const address=endpoint?.trim().replace(/\/+$/,'')||(mode==='agent'?SDK_AGENT_ENDPOINT:'');
  const fallback=JSON.stringify(address),hasFallback=!!address;
  const singleQuoted="'"+address.replaceAll("\\","\\\\").replaceAll("'","\\'")+"'";
  const examples:Record<string,string>={
    typescript:`import {createLightMoni} from '@lightmoni/sdk';

const moni = createLightMoni({
  service: 'order-api', table: 'business',
  endpoint: process.env.LIGHTMONI_ENDPOINT ?? ${fallback},
  key: process.env.LIGHTMONI_KEY
});
await moni.withSpan('create_order', async () => {
  moni.counter('orders_created').add(1, {region:'cn'});
  moni.log('info', 'order created', {order_id:'123'});
});
await moni.shutdown({timeoutMs:5000});`,
    go:`import (
  "context"
  "os"
  "time"
  moni "github.com/lightmoni/lightmoni/sdk/go"
)

endpoint := os.Getenv("LIGHTMONI_ENDPOINT")
${hasFallback?`if endpoint == "" { endpoint = ${fallback} }\n`:''}client, err := moni.New(moni.Config{
  Service:"order-api", Table:"business",
  Endpoint:endpoint, Key:os.Getenv("LIGHTMONI_KEY"),
})
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
    python:`import os
from lightmoni import Client

moni = Client(
    service="order-api", table="business",
    endpoint=os.getenv("LIGHTMONI_ENDPOINT", ${fallback}),
    key=os.getenv("LIGHTMONI_KEY", "")
)
moni.counter("orders_created").add(1, {"region":"cn"})
with moni.start_span("create_order"):
    moni.log("info", "order created", {"order_id":"123"})
moni.shutdown(timeout=5)`,
    java:`import io.lightmoni.Client;
import java.time.Duration;
import java.util.Map;

var moni = new Client("order-api", "business",
    System.getenv().getOrDefault("LIGHTMONI_ENDPOINT", ${fallback}),
    System.getenv().getOrDefault("LIGHTMONI_KEY", ""));
moni.counter("orders_created").add(1, Map.of("region","cn"));
moni.withSpan("create_order", span -> {
  moni.log("info", "order created", Map.of("order_id","123"));
  return null;
});
moni.shutdown(Duration.ofSeconds(5));`,
    dotnet:`using System;
using System.Collections.Generic;
using LightMoni;

var moni = new Client("order-api", "business",
    endpoint: Environment.GetEnvironmentVariable("LIGHTMONI_ENDPOINT") ?? ${fallback},
    key: Environment.GetEnvironmentVariable("LIGHTMONI_KEY") ?? "");
moni.Counter("orders_created").Add(1,
  new Dictionary<string,object> {["region"]="cn"});
using (var span = moni.StartSpan("create_order"))
using (var scope = span.MakeCurrent())
  moni.Log("info", "order created");
await moni.ShutdownAsync(TimeSpan.FromSeconds(5));`,
    php:`require './lightmoni-php-sdk/sdk/php/src/Client.php';

$moni = new \\LightMoni\\Client('order-api', 'business',
    getenv('LIGHTMONI_ENDPOINT') ?: ${singleQuoted},
    getenv('LIGHTMONI_KEY') ?: '');
$moni->counter('orders_created')->add(1, ['region'=>'cn']);
$moni->withSpan('create_order', function() use ($moni) {
  $moni->log('info', 'order created', ['order_id'=>'123']);
});
$moni->shutdown(5);`,
    ruby:`require 'lightmoni'

moni = LightMoni::Client.new(
  service:'order-api', table:'business',
  endpoint:ENV.fetch('LIGHTMONI_ENDPOINT'${hasFallback?`, ${singleQuoted}`:''}),
  key:ENV.fetch('LIGHTMONI_KEY'${mode==='agent'?", ''":''})
)
moni.counter('orders_created').add(1, 'region'=>'cn')
moni.with_span('create_order') do
  moni.log('info', 'order created', 'order_id'=>'123')
end
moni.shutdown(timeout:5)`,
    rust:`use lightmoni::{Client, Attributes};
use std::{env, time::Duration};

let endpoint = env::var("LIGHTMONI_ENDPOINT")${hasFallback?`.unwrap_or_else(|_| ${fallback}.into())`:'?'};
let key = env::var("LIGHTMONI_KEY")${mode==='agent'?'.unwrap_or_default()':'?'};
let moni = Client::new("order-api", "business", &endpoint, &key)?;
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
  return `export LIGHTMONI_ENDPOINT=${quote(base)}\n`+(mode==='direct'?"export LIGHTMONI_KEY='替换为允许 business 表的上报 Key'":"unset LIGHTMONI_KEY\n# Agent 开启本地访问令牌时，将 LIGHTMONI_KEY 设为该令牌");
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
  java:{
    language:'java',
    install:'tar -xzf lightmoni-java-sdk_0.1.0.tar.gz\nmvn -f lightmoni-java-sdk/sdk/java/pom.xml install\n# 业务依赖：io.lightmoni:lightmoni-sdk:0.1.0',
    sample:sdkSampleFor('java'),
  },
  dotnet:{
    language:'csharp',
    install:'tar -xzf lightmoni-dotnet-sdk_0.1.0.tar.gz\ndotnet add YourApp.csproj reference ./lightmoni-dotnet-sdk/sdk/dotnet/LightMoni.csproj',
    sample:sdkSampleFor('dotnet'),
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
