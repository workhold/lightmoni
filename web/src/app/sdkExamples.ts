import type {ReportingAddress} from './reporting-addresses';
export type SDKConnectionMode='agent'|'direct';
export type SDKAuthMode='key'|'anonymous';
export const SDK_AGENT_ENDPOINT='http://127.0.0.1:4318';
export const SDK_LANGUAGES=[{value:'go',label:'Go'},{value:'typescript',label:'Node.js'},{value:'rust',label:'Rust'},{value:'python',label:'Python'}];
export interface SDKSampleOptions {table?:string;service?:string;authMode?:SDKAuthMode;key?:string;keyName?:string}
export const validSDKTable=(name:string)=>/^[a-z][a-z0-9_]{0,47}$/.test(name)&&!/^(log|metric|trace)_/.test(name)&&!['lightmoni_center','lightmoni_agent','lightmoni_sdk'].includes(name);
export function recommendedExemptTables(){
 const suffix=Array.from(crypto.getRandomValues(new Uint8Array(8)),value=>value.toString(16).padStart(2,'0')).join('');
 return [{name:`app_logs_${suffix}`,description:'应用日志'},{name:`app_metrics_${suffix}`,description:'业务指标'},{name:`browser_events_${suffix}`,description:'前端事件'}];
}
export function sdkSampleFor(language:string,mode:SDKConnectionMode='agent',endpoint?:string,options:SDKSampleOptions={}):string {
 const address=endpoint?.trim().replace(/\/+$/,'')||(mode==='agent'?SDK_AGENT_ENDPOINT:'');
 const fallback=JSON.stringify(address),table=JSON.stringify(options.table??'business'),service=JSON.stringify(options.service??'order-api'),anonymous=options.authMode==='anonymous';
 const examples:Record<string,string>={
  typescript:`import {createLightMoni} from '@lightmoni/sdk';

const moni = createLightMoni({
  service: ${service}, table: ${table},
  endpoint: process.env.LIGHTMONI_ENDPOINT ?? ${fallback},
  key: ${anonymous?"''":"process.env.LIGHTMONI_KEY"}
});
await moni.withSpan('create_order', async () => {
  moni.counter('orders_created').add(1, {region:'cn'});
  moni.log('info', 'order created', {order_id:'123'});
});
await moni.shutdown({timeoutMs:5000});`,
  go:`package main

import (
  "context"
  "os"
  "time"
  moni "github.com/lightmoni/lightmoni/sdk/go"
)

func main() {
  endpoint := os.Getenv("LIGHTMONI_ENDPOINT")
  if endpoint == "" { endpoint = ${fallback} }
  client, err := moni.New(moni.Config{
    Service:${service}, Table:${table},
    Endpoint:endpoint, Key:${anonymous?'""':'os.Getenv("LIGHTMONI_KEY")'},
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
  if err := client.Shutdown(ctx); err != nil { panic(err) }
}`,
  python:`import os
from lightmoni import Client

moni = Client(
    service=${service}, table=${table},
    endpoint=os.getenv("LIGHTMONI_ENDPOINT", ${fallback}),
    key=${anonymous?'""':'os.getenv("LIGHTMONI_KEY", "")'}
)
moni.counter("orders_created").add(1, {"region":"cn"})
with moni.start_span("create_order"):
    moni.log("info", "order created", {"order_id":"123"})
moni.shutdown(timeout=5)`,
  rust:`use lightmoni::{Client, Attributes};
use std::{env, time::Duration};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let endpoint = env::var("LIGHTMONI_ENDPOINT")
        .unwrap_or_else(|_| ${fallback}.into());
    let key = ${anonymous?'String::new()':'env::var("LIGHTMONI_KEY").unwrap_or_default()'};
    let moni = Client::new(${service}, ${table}, &endpoint, &key)?;
    moni.counter("orders_created")?.add(1,
        &Attributes::from([("region".into(), "cn".into())]));
    moni.with_span("create_order", &Attributes::new(), None, |scoped, _| {
        scoped.log("info", "order created", &Attributes::new(), None);
    })?;
    moni.shutdown(Duration::from_secs(5))?;
    Ok(())
}`,
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
export function sdkEnvironment(mode:SDKConnectionMode,endpoint:string,options:SDKSampleOptions={}):string {
 const quote=(value:string)=>"'"+value.replaceAll("'", "'\\''")+"'";
 const base=endpoint.trim().replace(/\/+$/,'');
 const key=options.key??`填写 SDK 密钥「${options.keyName??'所选密钥'}」的完整值`;
 return `export LIGHTMONI_ENDPOINT=${quote(base)}\n`+(options.authMode==='anonymous'?'unset LIGHTMONI_KEY':mode==='direct'?`export LIGHTMONI_KEY=${quote(key)}`:'unset LIGHTMONI_KEY\n# 执行节点开启本地访问令牌时，将 LIGHTMONI_KEY 设为该令牌');
}
export interface SDKPackage {id:string;language:string;runtime:string;file:string;url:string;available:boolean}
export interface SDKInstall {endpoint?:string;endpoints?:ReportingAddress[];default_endpoint_id?:string;version:string;node_url:string;go_url:string;packages:SDKPackage[];checksums_url:string}
export const sdkExamples:Record<string,{language:string;install:string;sample:string}>={
 typescript:{language:'typescript',install:'npm install ./lightmoni-sdk-0.1.0.tgz',sample:sdkSampleFor('typescript')},
 go:{language:'go',install:'tar -xzf lightmoni-go-sdk_0.1.0.tar.gz\ngo mod edit -replace github.com/lightmoni/lightmoni=./lightmoni-go-sdk\ngo get github.com/lightmoni/lightmoni/sdk/go\ngo mod tidy',sample:sdkSampleFor('go')},
 rust:{language:'rust',install:'tar -xzf lightmoni-rust-sdk_0.1.0.tar.gz\n# Cargo.toml [dependencies]\n# lightmoni = { path = "./lightmoni-rust-sdk/sdk/rust" }',sample:sdkSampleFor('rust')},
 python:{language:'python',install:'tar -xzf lightmoni-python-sdk_0.1.0.tar.gz\npython3 -m pip install ./lightmoni-python-sdk/sdk/python',sample:sdkSampleFor('python')},
};
