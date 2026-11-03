#!/usr/bin/env python3
"""Verify JSON OTLP SDK defaults; Go uses sdk/go/client_test.go (protobuf).

Run scripts/test-sdks.py first to prepare native fixture dependencies.
Rust additionally requires its pinned target/debug/deps artifacts.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'.lightmoni/091-sdk-environment'
IMAGES={'java':'m.daocloud.io/docker.io/library/eclipse-temurin:17-jdk','dotnet':'mcr.microsoft.com/dotnet/sdk:8.0','php':'m.daocloud.io/docker.io/library/php:8.3-cli','rust':'m.daocloud.io/docker.io/library/rust:1-bookworm'}
class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args): pass
    def do_GET(self): self.reply(404,{})
    def reply(self,status,data):
        raw=json.dumps(data).encode();self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
    def do_POST(self):
        body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        if self.path.endswith('/logs'):
            with self.server.lock:self.server.rows.append((self.headers.get('Authorization'),body))
        self.reply(200,{})

def run(cmd,env=None): subprocess.run(cmd,cwd=ROOT,env=env,check=True,timeout=90,stdout=subprocess.DEVNULL)
def docker(language,args,env=None):
    cmd=['docker','run','--rm','-v',str(ROOT)+':/work','-w','/work']
    for key,value in (env or {}).items():cmd+=['-e',key+'='+value]
    return cmd+[IMAGES[language]]+args

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--languages',default='node,python,ruby,java,dotnet,php,rust');args=parser.parse_args()
    OUT.mkdir(parents=True,exist_ok=True)
    server=ThreadingHTTPServer(('0.0.0.0',0),Handler);server.rows=[];server.lock=threading.Lock();threading.Thread(target=server.serve_forever,daemon=True).start()
    values={'LIGHTMONI_SERVICE':'deployment-service','LIGHTMONI_KEY':'fixture-environment-secret','LIGHTMONI_INSTANCE_ID':'deployment-instance','LIGHTMONI_MACHINE_NAME':'platform-machine','LIGHTMONI_MACHINE_ID':'machine-id','LIGHTMONI_HOST_ID':'observed-host-id','LIGHTMONI_AGENT_ID':'agent-id','LIGHTMONI_APPLICATION_ID':'application-id','LIGHTMONI_CLUSTER_ID':'cluster-id','LIGHTMONI_DEPLOYMENT_ID':'deployment-id'}
    sources={
      'node':('main.mjs','''import {createLightMoni} from '../../sdk/typescript/dist/src/index.js';const c=createLightMoni({table:'business',selfTelemetry:false,remoteConfig:false,resource:{'host.name':'custom-host'}});c.log('info','environment');await c.shutdown();'''),
      'python':('main.py','''from lightmoni import Client\nc=Client(table='business',self_telemetry=False,remote_config=False,resource={'host.name':'custom-host'})\nc.log('info','environment')\nc.shutdown()\n'''),
      'ruby':('main.rb',"require_relative '../../sdk/ruby/lib/lightmoni'\nc=LightMoni::Client.new(table:'business',self_telemetry:false,resource:{'host.name'=>'custom-host'});c.log('info','environment');c.shutdown\n"),
      'java':('EnvCheck.java','''import io.lightmoni.Client;import java.util.Map;public class EnvCheck {public static void main(String[] a)throws Exception {try(var c=new Client(null,"business",null,null,new Client.Limits(),Map.of("host.name","custom-host"),null)){c.log("info","environment",Map.of(),null);}}}'''),
      'dotnet':('Program.cs','''using LightMoni;var c=new Client(null,"business",resource:new Dictionary<string,object>{{"host.name","custom-host"}});c.Log("info","environment");await c.ShutdownAsync();'''),
      'php':('main.php',"<?php require 'sdk/php/src/Client.php';$c=LightMoni\\Client::fromEnvironment('business',['host.name'=>'custom-host']);$c->log('info','environment');$c->shutdown();"),
      'rust':('main.rs','''use lightmoni::{Client,Options,Attributes};use std::time::Duration;fn main(){let c=Client::init_with_resource(Options::default(),Attributes::from([("host.name".into(),"custom-host".into())])).unwrap().with_table("business").unwrap();c.log("info","environment",&Attributes::new(),None);c.shutdown(Duration::from_secs(5)).unwrap();}''')}
    try:
      for language in args.languages.split(','):
        name,source=sources[language];path=OUT/name;path.write_text(source)
        # The files sit two directories below the repository.
        env=dict(os.environ,**values,LIGHTMONI_ENDPOINT=f'http://127.0.0.1:{server.server_port}',PYTHONPATH=str(ROOT/'sdk/python'))
        mounted=dict(values,LIGHTMONI_ENDPOINT=f'http://host.docker.internal:{server.server_port}')
        relative=str(path.relative_to(ROOT))
        before=len(server.rows)
        if language=='node':run(['node',relative],env)
        elif language=='python':run(['python3',relative],env)
        elif language=='ruby':run(['ruby',relative],env)
        elif language=='php':run(docker(language,['php',relative],mounted))
        elif language=='java':
          jar='.lightmoni/sdk-test/java/gson.jar';run(docker(language,['javac','-cp',jar,'-d',str(OUT.relative_to(ROOT)),'sdk/java/src/main/java/io/lightmoni/Client.java',relative]));run(docker(language,['java','-cp',jar+':'+str(OUT.relative_to(ROOT)),'EnvCheck'],mounted))
        elif language=='dotnet':
          (OUT/'EnvCheck.csproj').write_text('<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net8.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><EnableDefaultCompileItems>false</EnableDefaultCompileItems></PropertyGroup><ItemGroup><Compile Include="Program.cs"/><ProjectReference Include="../../sdk/dotnet/LightMoni.csproj"/></ItemGroup></Project>')
          run(docker(language,['dotnet','build',str(OUT.relative_to(ROOT))+'/EnvCheck.csproj','--nologo','-o',str(OUT.relative_to(ROOT))+'/dotnet']));run(docker(language,['dotnet',str(OUT.relative_to(ROOT))+'/dotnet/EnvCheck.dll'],mounted))
        elif language=='rust':
          # Reuses already pinned compiled dependencies when crates.io is unavailable.
          script='rustc --edition=2021 --crate-name lightmoni sdk/rust/src/lib.rs --crate-type rlib --out-dir .lightmoni/091-sdk-environment -L dependency=sdk/rust/target/debug/deps '
          script+=' '.join('--extern '+dep+'=$(ls sdk/rust/target/debug/deps/lib'+dep+'-*.rlib | head -1)' for dep in ['reqwest','serde_json','uuid','httpdate'])
          script+=' && rustc --edition=2021 '+relative+' -o .lightmoni/091-sdk-environment/rust-env -L dependency=sdk/rust/target/debug/deps --extern lightmoni=.lightmoni/091-sdk-environment/liblightmoni.rlib'
          run(docker(language,['sh','-c',script]));run(docker(language,['.lightmoni/091-sdk-environment/rust-env'],mounted))
        rows=server.rows[before:];assert rows,language+' emitted no logs'
        auth,body=rows[0];assert auth=='Bearer '+values['LIGHTMONI_KEY'],language+' missing env authentication'
        attrs={a['key']:a['value']['stringValue'] for a in body['resourceLogs'][0]['resource']['attributes']}
        assert attrs['service.name']==values['LIGHTMONI_SERVICE'] and attrs['service.instance.id']==values['LIGHTMONI_INSTANCE_ID'],language+' missing service identity'
        assert attrs['host.name']=='custom-host' and attrs['host.id']=='observed-host-id' and attrs['lightmoni.machine_id']=='machine-id',language+' missing/overwritten host identity'
        assert attrs['lightmoni.application_id']=='application-id' and attrs['lightmoni.cluster_id']=='cluster-id',language+' missing deployment identity'
        assert values['LIGHTMONI_KEY'] not in json.dumps(body),language+' exposed key in telemetry'
        print('PASS '+language+': environment authentication, service/instance, host/deployment metadata, explicit resource override, no secret attribute',flush=True)
    finally:server.shutdown();server.server_close()
if __name__=='__main__':main()
