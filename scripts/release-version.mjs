#!/usr/bin/env node
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const repo=resolve(process.env.LIGHTMONI_RELEASE_ROOT??fileURLToPath(new URL('..',import.meta.url)));
const path=file=>resolve(repo,file);
const read=file=>readFileSync(path(file),'utf8');
const write=(file,text)=>writeFileSync(path(file),text);
const packageFiles=['package.json','runtime/package.json','ai-runtime/package.json','web/package.json','sdk/typescript/package.json'];
const lockFiles=['package-lock.json','runtime/package-lock.json','ai-runtime/package-lock.json','web/package-lock.json','sdk/typescript/package-lock.json'];
const textFiles=[
 'README.md','runtime/src/agent/config.ts','runtime/src/server/install.ts','runtime/src/server/settings.ts','runtime/src/server/managed-machines.ts','runtime/src/server/agent-credentials.ts','runtime/src/mcp/transport.ts',
 'deploy/agent/install.sh','deploy/agent/release.sh','deploy/server/Dockerfile',
 'scripts/build-agent-release.mjs','scripts/build-go-sdk.sh','scripts/build-native-sdks.sh','scripts/build-sdk-release.sh',
 'web/src/app/MachinesPage.tsx','web/src/app/MachineBatchDialog.tsx','web/src/app/sdkExamples.ts','sdk/go/runtime.go','sdk/typescript/src/core.ts',
 'sdk/python/pyproject.toml','sdk/python/lightmoni/__init__.py','sdk/rust/Cargo.toml','sdk/rust/src/lib.rs',
 'sdk/java/pom.xml','sdk/java/README.md','sdk/java/src/main/java/io/lightmoni/Client.java',
 'sdk/ruby/lightmoni.gemspec','sdk/ruby/README.md','sdk/ruby/lib/lightmoni.rb',
 'sdk/php/composer.json','sdk/php/README.md','sdk/php/src/Client.php','sdk/dotnet/LightMoni.csproj','sdk/dotnet/Client.cs',
];
const imagePattern=/^(\s*image:\s*docker\.heyphp\.com\/lightmoni\/lightmoni:)(\S+)\s*$/m;
const semver=/^\d+\.\d+\.\d+$/;
const parseJSON=file=>JSON.parse(read(file));
const packageVersion=()=>parseJSON('package.json').version;
const compare=(left,right)=>{const a=left.split('.').map(Number),b=right.split('.').map(Number);for(let i=0;i<3;i++)if(a[i]!==b[i])return a[i]-b[i];return 0};
const composeTag=version=>`v${version}-${new Date().toISOString().replace(/[-:]/g,'').replace('T','-').slice(0,15)}-amd64`;
const expectedTag=version=>new RegExp('^v'+version.replaceAll('.','\\.')+'-\\d{8}-\\d{6}-amd64$');
const cargoPattern=/(name = "lightmoni"\nversion = ")(\d+\.\d+\.\d+)(")/;

function validateJSON(file,version,lock=false){
 const value=parseJSON(file);
 if(value.version!==version)throw Error(`${file}: version ${value.version} != ${version}`);
 if(lock){
  if(value.packages?.['']?.version!==version)throw Error(`${file}: root package version mismatch`);
  const local=value.packages?.['../sdk/typescript'];
  if(local&&local.version!==version)throw Error(`${file}: local SDK version mismatch`);
 }
}
function validate(version,compose=true){
 if(!semver.test(version))throw Error('Release version must use x.y.z');
 for(const file of packageFiles)validateJSON(file,version);
 for(const file of lockFiles)validateJSON(file,version,true);
 for(const file of textFiles)if(!read(file).includes(version))throw Error(`${file}: missing release version ${version}`);
 const cargo=read('sdk/rust/Cargo.lock').match(cargoPattern);
 if(!cargo||cargo[2]!==version)throw Error('sdk/rust/Cargo.lock: lightmoni package version mismatch');
 if(compose){
  const image=read('compose.yaml').match(imagePattern);
  if(!image||!expectedTag(version).test(image[2]))throw Error('compose.yaml: expected fixed version/time/amd64 image tag');
 }
}
function bump(next){
 if(!semver.test(next))throw Error('Release version must use x.y.z');
 const previous=packageVersion(),direction=compare(next,previous);
 if(direction<0)throw Error(`Refuse version downgrade ${previous} -> ${next}`);
 if(direction===0){validate(next);console.log(`Release version already ${next}; all checks passed`);return;}
 validate(previous,false);
 for(const file of [...packageFiles,...lockFiles]){
  const value=parseJSON(file);value.version=next;
  if(lockFiles.includes(file)){
   value.packages[''].version=next;
   if(value.packages['../sdk/typescript'])value.packages['../sdk/typescript'].version=next;
  }
  write(file,JSON.stringify(value,null,2)+'\n');
 }
 for(const file of textFiles)write(file,read(file).replaceAll(previous,next));
 write('sdk/rust/Cargo.lock',read('sdk/rust/Cargo.lock').replace(cargoPattern,`$1${next}$3`));
 const compose=read('compose.yaml'),tag=composeTag(next);
 if(!imagePattern.test(compose))throw Error('compose.yaml: image not found');
 write('compose.yaml',compose.replace(imagePattern,`$1${tag}`));
 validate(next);
 console.log(`Release version ${previous} -> ${next}\nCompose image tag: ${tag}`);
}

const [command,argument]=process.argv.slice(2);
try{
 if(command==='check'){const version=packageVersion();validate(version);console.log(`Release version ${version}: ${packageFiles.length+lockFiles.length+textFiles.length+2} checks passed`);}
 else if(command==='bump'&&argument)bump(argument);
 else throw Error('Usage: node scripts/release-version.mjs check | bump <x.y.z>');
}catch(error){console.error(error instanceof Error?error.message:String(error));process.exitCode=1;}
