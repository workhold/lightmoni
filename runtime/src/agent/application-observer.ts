import { spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { encodeOTLP, nowNano, formatNanoTime, parseNanoTime } from '../shared/otlp.js';
import { APPLICATION_TABLE, type ApplicationTarget, type DockerInventory } from '../shared/application-observation.js';
import { operationCommand } from './operations.js';
import { readDockerInventory, dockerError } from './docker.js';
import { saveLogCursor } from './queue.js';
import type { LogAgent } from './file-logs.js';
import type { LightMoni } from '@lightmoni/sdk';
import type { OperationExecutionContext } from '../operations/types.js';

type Output = {stdout: string; stderr: string; complete?: boolean; skipped?: string};
type Checkpoint = {time: bigint; count: bigint};
// Read a bounded prefix, never tail away an unsent backlog. Each stream has its
// own checkpoint: stdout/stderr ordering is not guaranteed by the Docker CLI.
export function readDockerLogs(args: string[], signal?: AbortSignal, selected?: 'stdout'|'stderr', checkpoint?: Checkpoint, fixed?:{executable:string;prefix:string[]}): Promise<Output> {
  return new Promise((resolve, reject) => {
    const child = spawn(fixed?.executable??'docker', [...(fixed?.prefix??['--context','default']),...args], {shell:false, stdio:['ignore','pipe','pipe'], signal,
      env: {PATH: process.env.PATH, HOME: process.env.HOME, LC_ALL:'C'}});
    const output = {stdout: Buffer.alloc(0), stderr: Buffer.alloc(0)};
    let bounded = false, skipped = 0n, prefix = Buffer.alloc(0), skipping = !!checkpoint?.count;
    const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
    for (const stream of ['stdout','stderr'] as const) child[stream].on('data',(chunk: Buffer) => {
      if(selected && stream!==selected)return;
      // Docker --since is inclusive. Discard acknowledged same-timestamp lines
      // before applying the byte bound, otherwise a large multiline event can
      // keep returning the same prefix forever.
      if(skipping){
        prefix=Buffer.concat([prefix,chunk]);let end;
        while((end=prefix.indexOf(10))>=0){
          const line=prefix.subarray(0,end);let same=false;
          try{same=parseNanoTime(line.subarray(0,line.indexOf(32)).toString())===checkpoint!.time;}catch{}
          if(!same||skipped>=checkpoint!.count){skipping=false;break;}
          skipped++;prefix=prefix.subarray(end+1);
          if(skipped>=checkpoint!.count){skipping=false;break;}
        }
        if(skipping&&prefix.length<(256<<10))return;
        chunk=prefix;prefix=Buffer.alloc(0);
      }
      const remaining = (256 << 10) - output[stream].length;
      if (remaining > 0) output[stream] = Buffer.concat([output[stream], chunk.subarray(0,remaining)]);
      if (chunk.length >= remaining) {bounded = true; child.kill('SIGKILL');}
    });
    child.once('error', () => {clearTimeout(timer); reject(Error('docker_logs_unavailable'));});
    child.once('close', code => {
      clearTimeout(timer);
      if(prefix.length&&selected){
        let acknowledged=false;try{acknowledged=skipped<checkpoint!.count&&parseNanoTime(prefix.subarray(0,prefix.indexOf(32)).toString())===checkpoint!.time;}catch{}
        if(acknowledged)skipped++;else output[selected]=Buffer.concat([output[selected],prefix]);
      }
      if (signal?.aborted || (code !== 0 && !bounded)) reject(Error('docker_logs_unavailable')); else resolve({stdout:output.stdout.toString('utf8'),stderr:output.stderr.toString('utf8'),complete:!bounded,skipped:skipped.toString()});
    });
  });
}
export function dockerBytes(value: string): number | undefined {
  const m = /^\s*([\d.]+)\s*(B|kB|KB|MB|GB|TB|KiB|MiB|GiB|TiB)?\s*$/.exec(value);
  if (!m) return;
  const units: Record<string,number> = {B:1,kB:1e3,KB:1e3,MB:1e6,GB:1e9,TB:1e12,KiB:1024,MiB:1024**2,GiB:1024**3,TiB:1024**4};
  const n = Number(m[1]) * (units[m[2] ?? 'B']);
  return Number.isFinite(n) ? n : undefined;
}
const str = (key: string, value: string) => ({key,value:{stringValue:value}});
export class ApplicationObserver {
  targets: ApplicationTarget[] = [];
  inventory?: DockerInventory;
  private inventoryPending?: Promise<DockerInventory>;
  private clients = new Map<string, ReturnType<LightMoni['gauge']>>();
  constructor(readonly agent: LogAgent & {sdk: LightMoni}, readonly command: OperationExecutionContext['command'] = operationCommand,
    readonly logs: (args:string[], signal?:AbortSignal,selected?:'stdout'|'stderr',checkpoint?:Checkpoint)=>Promise<Output> = readDockerLogs) {}
  refreshInventory(signal?: AbortSignal): Promise<DockerInventory> {
    if(this.inventoryPending)return this.inventoryPending;
    this.inventoryPending=readDockerInventory(this.command,signal).then(snapshot=>this.inventory=snapshot).catch(error=>{
      this.inventory={observed_at:this.inventory?.observed_at??new Date(0).toISOString(),attempted_at:new Date().toISOString(),state:'unavailable',error:dockerError(error),containers:this.inventory?.containers??[],truncated:this.inventory?.truncated??false};
      throw error;
    }).finally(()=>{this.inventoryPending=undefined;});
    return this.inventoryPending;
  }
  async collect(signal?: AbortSignal) {
    try {
      const {containers} = await this.refreshInventory(signal);
      const targets = new Map(this.targets.map(t=>[t.deployment_id,t]));
      const managed = containers.filter(c=>targets.has(c.deployment_id));
      const running = managed.filter(c=>c.state==='running');
      for (let offset=0;offset<running.length;offset+=32) {
        const group = running.slice(offset,offset+32);
        const data = await this.command('docker',['--context','default','stats','--no-stream','--no-trunc','--format','{{json .}}',...group.map(c=>c.id)],{timeoutMs:15000,signal});
        for (const line of data.stdout.trim().split('\n').filter(Boolean)) {
          const s=JSON.parse(line), c=group.find(c=>c.id===s.ID || c.id.startsWith(s.ID));
          if (!c) continue;
          const attrs={...targets.get(c.deployment_id)!,container_id:c.id,container_name:c.name};
          const record=(name:string,unit:string,value:number|undefined)=>{if(value===undefined||!Number.isFinite(value))return;let gauge=this.clients.get(name);if(!gauge){gauge=this.agent.sdk.withTable(APPLICATION_TABLE).gauge(name,{unit});this.clients.set(name,gauge);}gauge.record(value,attrs);};
          record('container.cpu.percent','%',parseFloat(s.CPUPerc));
          const mem=String(s.MemUsage).split('/'),net=String(s.NetIO).split('/'),io=String(s.BlockIO).split('/');
          record('container.memory.used','By',dockerBytes(mem[0]??''));record('container.memory.limit','By',dockerBytes(mem[1]??''));
          record('container.memory.percent','%',parseFloat(s.MemPerc));
          record('container.network.receive_bytes','By',dockerBytes(net[0]??''));record('container.network.transmit_bytes','By',dockerBytes(net[1]??''));
          record('container.disk.read_bytes','By',dockerBytes(io[0]??''));record('container.disk.write_bytes','By',dockerBytes(io[1]??''));record('container.pids','1',Number(s.PIDs));
        }
      }
      const failures: string[]=[];
      for (const c of managed) {
        if(signal?.aborted)break;
        try{await this.collectLogs(c,targets.get(c.deployment_id)!,signal);}catch{failures.push(c.id);}
      }
      if(failures.length)throw Error('application_log_collection_failed');
    } catch(error) {
      throw error;
    }
  }
  async collectLogs(c: {id:string;name:string}, target: ApplicationTarget, signal?: AbortSignal) {
    const base = 'docker:'+c.id+':', db=this.agent.queue.db;
    const cutoff=nowNano()-7n*86400000000000n;
    const cursor=(stream:string)=>{const id=createHash('sha256').update(base+stream).digest('hex');const old=db.get<any>('SELECT offset,generation,prefix FROM log_cursors WHERE id=?',id);return {id,path:base+stream,prefix:old?Buffer.from(old.prefix):Buffer.from('0'),offset:old?BigInt(old.offset):cutoff,generation:old?BigInt(old.generation):0n};};
    const cursors={stdout:cursor('stdout'),stderr:cursor('stderr')};
    for(const stream of ['stdout','stderr'] as const){
      const point=cursors[stream];let records:any[]=[],duplicate=0n;
      const flush=()=>{if(!records.length)return;this.agent.accept({id:randomUUID(),signal:'logs',table:APPLICATION_TABLE,service:'lightmoni-agent',created_at:formatNanoTime(nowNano()),payload:encodeOTLP('logs',{resourceLogs:[{resource:{attributes:[str('service.name','lightmoni-agent')]},scopeLogs:[{scope:{name:'lightmoni.application'},logRecords:records}]}]}),content_type:'application/x-protobuf'},true,{...point,prefix:Buffer.from(point.prefix)});records=[];};
      const until=nowNano();
      const output=await this.logs(['logs','--timestamps','--since',formatNanoTime(point.offset),'--until',formatNanoTime(until),c.id],signal,stream,{time:point.offset,count:point.generation});
      duplicate=BigInt(output.skipped??'0');
      const lines=output[stream].split('\n');
      for(const line of output.complete?lines.filter(Boolean):lines.slice(0,-1)){
        const space=line.indexOf(' ');if(space<0)continue;
        let time:bigint;try{time=parseNanoTime(line.slice(0,space));}catch{continue;}
        if(time<point.offset)continue;
        if(time===point.offset&&duplicate++<point.generation)continue;
        const body=line.slice(space+1),attributes:any[]=[...Object.entries({...target,container_id:c.id,container_name:c.name,stream}).map(([k,v])=>str(k,v))];
        try{const access=JSON.parse(body);if(access.lightmoni_access===true && /^[a-zA-Z0-9_-]{1,128}$/.test(access.website_id)){
          attributes.push(str('website_id',access.website_id),str('http_status',String(access.status)),str('request_duration',String(access.request_time)),str('upstream_addr',String(access.upstream_addr??'')));
        }}catch{}
        const sequence=BigInt(point.prefix.toString()||'0')+1n;
        attributes.push(str('lightmoni.source_id',point.id),{key:'lightmoni.source_seq',value:{intValue:sequence.toString()}});
        const record={timeUnixNano:time.toString(),observedTimeUnixNano:nowNano().toString(),severityText:stream==='stderr'?'ERROR':'INFO',severityNumber:stream==='stderr'?17:9,body:{stringValue:body},attributes};
        records.push(record);
        const request=()=>({resourceLogs:[{resource:{attributes:[str('service.name','lightmoni-agent')]},scopeLogs:[{scope:{name:'lightmoni.application'},logRecords:records}]}]});
        if(encodeOTLP('logs',request()).length+1024>this.agent.config.max_batch_bytes){records.pop();if(!records.length)throw Error('docker_log_line_exceeds_batch_limit');flush();records.push(record);if(encodeOTLP('logs',request()).length+1024>this.agent.config.max_batch_bytes)throw Error('docker_log_line_exceeds_batch_limit');}
        point.prefix=Buffer.from(sequence.toString());
        if(time===point.offset)point.generation++;else{point.offset=time;point.generation=1n;duplicate=1n;}
        if(records.length>=256)flush();
      }
      if(!output.complete&&output[stream].length && !output[stream].includes('\n'))throw Error('docker_log_line_exceeds_read_limit');
      flush();
      if(output.complete){point.offset=until;point.generation=0n;saveLogCursor(db,point);}
    }
  }
}
