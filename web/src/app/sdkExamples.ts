import type {ReportingAddress} from './reporting-addresses';
export type SDKConnectionMode='agent'|'direct';
export type SDKAuthMode='key'|'anonymous';
export const SDK_AGENT_ENDPOINT='http://127.0.0.1:4318';
export const SDK_LANGUAGES=[{value:'go',label:'Go'},{value:'typescript',label:'Node.js'},{value:'rust',label:'Rust'},{value:'python',label:'Python'}];
export interface SDKSampleOptions {service?:string;env?:string;service_version?:string;instance_id?:string;authMode?:SDKAuthMode;key?:string;keyName?:string}
export const validSDKTable=(name:string)=>/^[a-z][a-z0-9_]{0,47}$/.test(name)&&!/^(log|metric|trace)_/.test(name)&&!['lightmoni','lightmoni_center','lightmoni_agent','lightmoni_sdk'].includes(name);
export function recommendedExemptTables(){
 const suffix=Array.from(crypto.getRandomValues(new Uint8Array(8)),value=>value.toString(16).padStart(2,'0')).join('');
 return [{name:`app_logs_${suffix}`,description:'应用日志'},{name:`app_metrics_${suffix}`,description:'业务指标'},{name:`browser_events_${suffix}`,description:'前端事件'}];
}
export function sdkSampleFor(language:string,mode:SDKConnectionMode='agent',endpoint?:string,options:SDKSampleOptions={}):string {
 const address=endpoint?.trim().replace(/\/+$/,'')||(mode==='agent'?SDK_AGENT_ENDPOINT:'');
 const fallback=JSON.stringify(address),service=JSON.stringify(options.service??'order-api'),env=JSON.stringify(options.env??'test'),anonymous=options.authMode==='anonymous';
 const jsIdentity=(options.service_version?`\n  service_version: ${JSON.stringify(options.service_version)},`:'')+(options.instance_id?`\n  instance_id: ${JSON.stringify(options.instance_id)},`:'');
 const pyIdentity=(options.service_version?`\n    service_version=${JSON.stringify(options.service_version)},`:'')+(options.instance_id?`\n    instance_id=${JSON.stringify(options.instance_id)},`:'');
 const goIdentity=(options.service_version?` ServiceVersion:${JSON.stringify(options.service_version)},`:'')+(options.instance_id?` InstanceID:${JSON.stringify(options.instance_id)},`:'');
 const rustIdentity=(options.service_version?`\n    options.service_version = Some(${JSON.stringify(options.service_version)}.into());`:'')+(options.instance_id?`\n    options.instance_id = Some(${JSON.stringify(options.instance_id)}.into());`:'');
 const examples:Record<string,string>={
  typescript:`import {createLightMoni} from '@lightmoni/sdk';

const moni = createLightMoni({
  service: ${service}, env: ${env},${jsIdentity}
  endpoint: process.env.LIGHTMONI_ENDPOINT ?? ${fallback},
  key: ${anonymous?"''":"process.env.LIGHTMONI_KEY"}
});

// 每次数据库请求完成后调用，替换 your_table 为业务目标表。
function recordDatabaseQuery(durationMs, isp, province) {
  moni.record('your_table', 'db.query.duration_ms',
    {key1: isp, key2: province}, durationMs, 1);
}
// 已有汇总数据：moni.record('your_table', 'restaurant.spend', {}, 100, 5);
// 进程退出前执行：
await moni.shutdown({timeoutMs:5000});`,
  go:`package main

import (
  "context"
  "os"
  "time"
  moni "github.com/lightmoni/lightmoni/sdk/go"
)

func recordDatabaseQuery(client *moni.Client, durationMs float64, isp, province string) {
  client.Record("your_table", "db.query.duration_ms",
    moni.Attributes{"key1":isp, "key2":province}, durationMs, 1)
}

func main() {
  endpoint := os.Getenv("LIGHTMONI_ENDPOINT")
  if endpoint == "" { endpoint = ${fallback} }
  client, err := moni.New(moni.Config{
    Service:${service}, Env:${env},${goIdentity}
    Endpoint:endpoint, Key:${anonymous?'""':'os.Getenv("LIGHTMONI_KEY")'},
  })
  if err != nil { panic(err) }
  // 每次数据库请求后调用 recordDatabaseQuery，替换 your_table。
  // 已有汇总数据：client.Record("your_table", "restaurant.spend", nil, 100, 5)
  ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
  defer cancel()
  if err := client.Shutdown(ctx); err != nil { panic(err) }
}`,
  python:`import os
from lightmoni import Client

moni = Client(
    service=${service}, env=${env},${pyIdentity}
    endpoint=os.getenv("LIGHTMONI_ENDPOINT", ${fallback}),
    key=${anonymous?'""':'os.getenv("LIGHTMONI_KEY", "")'}
)

def record_database_query(duration_ms, isp, province):
    # 每次数据库请求后调用，替换 your_table。
    moni.record("your_table", "db.query.duration_ms",
                {"key1": isp, "key2": province}, duration_ms, 1)

# 已有汇总数据：moni.record("your_table", "restaurant.spend", {}, 100, 5)
moni.shutdown(timeout=5)`,
  rust:`use lightmoni::{Client, Options, Attributes};
use std::{env, time::Duration};

fn record_database_query(moni: &Client, duration_ms: f64, isp: &str, province: &str) {
    moni.record("your_table", "db.query.duration_ms",
        &Attributes::from([("key1".into(), isp.into()), ("key2".into(), province.into())]),
        duration_ms, 1);
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut options = Options::new(${service}, ${env});${rustIdentity}
    options.endpoint = Some(env::var("LIGHTMONI_ENDPOINT")
        .unwrap_or_else(|_| ${fallback}.into()));
    options.key = ${anonymous?'Some(String::new())':'env::var("LIGHTMONI_KEY").ok()'};
    let moni = Client::init(options)?;
    // 每次数据库请求后调用 record_database_query，替换 your_table。
    // 已有汇总数据：moni.record("your_table", "restaurant.spend", &Attributes::new(), 100.0, 5);
    moni.shutdown(Duration::from_secs(5))?;
    Ok(())
}`,
 };
 return examples[language]??examples.typescript;
}
export function sdkEndpointError(endpoint:string,language='zh-CN'):string {
 try {
  const value=endpoint.trim();
  if(!/^https?:\/\//i.test(value)||/[?#\\\s]/.test(value))throw new Error();
  const url=new URL(value);
  if(!['http:','https:'].includes(url.protocol)||!url.hostname||url.username||url.password||url.search||url.hash)throw new Error();
  return '';
 } catch { return language==='en-US'||language==='en'?'Enter a complete HTTP(S) URL without credentials, query parameters, or fragments':'请输入完整的 HTTP(S) 地址，不包含用户名、密码、查询参数或片段'; }
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
