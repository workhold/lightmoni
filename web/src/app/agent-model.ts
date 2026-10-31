export const hostCollectors = [
  {value:'cpu',label:'CPU'}, {value:'memory',label:'内存与 Swap'},
  {value:'filesystem',label:'文件系统空间'}, {value:'disk',label:'磁盘 I/O'},
  {value:'network',label:'网络流量'}, {value:'system',label:'负载与运行时间'},
  {value:'process',label:'指定进程'},
];
export interface ProbeTask {id:string;kind:'http'|'tcp';target:string;interval_seconds:number;timeout_ms:number;expected_status?:number[]}
export interface LogSource {directory:string;pattern:string;recursive:boolean;from_beginning:boolean}
export interface AgentTasks {
  revision?:string;collect_interval_seconds:number;host_enabled:boolean;host_collectors:string[];
  host_table:string;probe_table:string;process_names:string[];probes:ProbeTask[];
  logs_enabled:boolean;log_table:string;log_sources:LogSource[];
  group_id?:string;
}
export interface AgentGroup {id:string;name:string;config:AgentTasks;agent_count:number}
export type AgentTaskType = 'host'|'probe'|'log'|'script';
export const agentTaskTypes:{value:AgentTaskType;label:string}[] = [
  {value:'host',label:'指标采集'},{value:'probe',label:'服务拨测'},{value:'log',label:'目录日志'},{value:'script',label:'脚本任务'},
];
export const taskTypeName = (type:AgentTaskType,language:string='zh-CN') => language==='en-US'
  ? ({host:'Metric collection',probe:'Service probes',log:'Directory logs',script:'Script task'}[type] ?? type)
  : agentTaskTypes.find(item=>item.value===type)?.label ?? type;
export const hostCollectorName = (value:string,language:string='zh-CN') => language==='en-US'
  ? ({cpu:'CPU',memory:'Memory and swap',filesystem:'Filesystem space',disk:'Disk I/O',network:'Network traffic',system:'Load and uptime',process:'Selected processes'} as Record<string,string>)[value] ?? value
  : hostCollectors.find(item=>item.value===value)?.label ?? value;
export interface AgentTaskLabel {id:string;name:string;node_count?:number;host_count?:number;task_count:number}
export interface TaskScript {runtime:'shell'|'node';code:string;timeout_seconds:number;max_output_bytes:number;args?:string[];cwd?:string}
export interface TaskSchedule {mode:'continuous'|'once'|'interval'|'at'|'cron';interval_seconds?:number;run_at?:string;cron?:string;timezone?:string}
export interface TaskExecutionPolicy {max_concurrency:number;queue_timeout_seconds:number;retry_count:number;retry_delay_seconds:number}
export const defaultExecutionPolicy:TaskExecutionPolicy={max_concurrency:10,queue_timeout_seconds:3600,retry_count:0,retry_delay_seconds:60};
export interface TaskHost {task_capabilities?:string[];id:string;name:string;agent_id:string;agent_status?:string;label_ids:string[];labels?:{id:string;name:string}[]}
export interface ManagedAgentTask {revision?:string;id:string;name:string;type:AgentTaskType;enabled:boolean;label_ids:string[];config:AgentTasks;origin?:'builtin'|'custom';target_all?:boolean;host_ids?:string[];schedule?:TaskSchedule;script?:TaskScript;execution_policy?:TaskExecutionPolicy}
export const requiredScriptCapability=(script?:TaskScript)=>script?.args?.length||script?.cwd?'task.script.v2':'task.script.v1';
export const hostCanRunScript=(host:TaskHost,script?:TaskScript)=>!!host.agent_id&&!!host.task_capabilities?.some(capability=>capability===requiredScriptCapability(script)||capability==='task.script.v2');
export const taskScheduleSummary=(schedule?:TaskSchedule,language='zh-CN')=>{
 const en=language==='en-US';
 if(schedule?.mode==='interval')return en?`Every ${schedule.interval_seconds} seconds`:`每 ${schedule.interval_seconds} 秒`;
 if(schedule?.mode==='cron')return `${schedule.cron} · ${schedule.timezone}`;
 if(schedule?.mode==='at')return schedule.run_at?new Date(schedule.run_at).toLocaleString(language):(en?'Once at a scheduled time':'单次定时');
 return schedule?.mode==='continuous'?(en?'Continuous collection':'持续采集'):(en?'Manual dispatch':'手动派发');
};
export interface EffectiveHostTask extends ManagedAgentTask {status:string;overridden:boolean}
export interface TaskRun {automatic_attempt?:number;resolved_at?:string;resolved_by?:string;resolution_reason?:string;superseded_by?:string;details_omitted?:boolean;id:string;task_id:string;task_name:string;host_id:string;host_name:string;agent_id:string;state:'queued'|'running'|'succeeded'|'failed'|'cancelled'|'unknown';trigger:'manual'|'schedule'|'retry';retry_of:string;created_at:string;started_at:string;finished_at:string;lease_expires_at:string;cancel_requested:boolean;code:string;summary:string;stdout:string;stderr:string;exit_code:number|null;snapshot:{task_id:string;task_name:string;host_id:string;host_name:string;agent_id:string;script:TaskScript;task_revision?:string;execution_policy?:TaskExecutionPolicy}}
export interface AgentItem {
  machine_id?:string;machine_name?:string;
  release?:{version?:string;source_revision?:string;build_id?:string;state_schema?:number;artifact_sha256?:string};boot_id?:string;
  id:string;hostname:string;platform:string;arch:string;version:string;last_seen:string;
  lifecycle_state?:'active'|'removed';removed_at?:string;removal_reason?:string;
  heartbeat:Record<string,unknown>;config:AgentTasks;group_id:string;group_name:string;
  label_ids:string[];labels:{id:string;name:string}[];task_ids:string[];tasks:{id:string;name:string;type:AgentTaskType}[];
}
export const defaultTasks:AgentTasks = {
  collect_interval_seconds:15,host_enabled:true,
  host_collectors:hostCollectors.filter(item => item.value !== 'process').map(item => item.value),
  host_table:'host',probe_table:'probe',process_names:[],probes:[],
  logs_enabled:false,log_table:'files',log_sources:[],
};
export const normalizeTasks = (tasks?:Partial<AgentTasks>):AgentTasks => ({...defaultTasks,...tasks,
  host_enabled:tasks?.host_enabled ?? true,host_collectors:tasks?.host_collectors ?? defaultTasks.host_collectors,
  host_table:'host',probe_table:'probe',
  process_names:tasks?.process_names ?? [],probes:tasks?.probes ?? [],
  logs_enabled:tasks?.logs_enabled ?? false,log_table:'files',log_sources:tasks?.log_sources ?? [],
});
export interface TaskForm extends Omit<AgentTasks,'probes'> {
  name?:string;type?:AgentTaskType;enabled?:boolean;label_ids?:string[];target_all?:boolean;host_ids?:string[];schedule?:TaskSchedule;script?:TaskScript;execution_policy?:TaskExecutionPolicy;script_args_text?:string;
  probes:(Omit<ProbeTask,'timeout_ms'|'expected_status'> & {timeout_seconds:number;expected_status:string[]})[];
}
export const taskFormValues = (tasks:AgentTasks):TaskForm => ({...normalizeTasks(tasks),
  probes:(tasks.probes ?? []).map(probe => ({...probe,timeout_seconds:probe.timeout_ms/1000,expected_status:(probe.expected_status ?? []).map(String)})),
});
export const taskPayload = (values:TaskForm):AgentTasks => ({...(({name:_,type:__,enabled:___,label_ids:____,target_all:_____,host_ids:______,schedule:_______,script:________,execution_policy:_________,script_args_text:__________,...rest}) => rest)(values),
  host_table:'host',probe_table:'probe',
  log_table:'files',log_sources:(values.log_sources ?? []).map(source => ({...source,directory:source.directory.trim(),pattern:source.pattern.trim() || '*.log*'})),
  process_names:(values.process_names ?? []).map(name => name.trim()),
  probes:(values.probes ?? []).map(({timeout_seconds,expected_status,...probe}) => ({...probe,
    id:probe.id.trim(),target:probe.target.trim(),timeout_ms:Math.round(timeout_seconds*1000),
    expected_status:probe.kind === 'http' ? (expected_status ?? []).map(Number) : [],
  })),
});
export const localizedLogicalTableRules = (language:string='zh-CN') => [{required:true,message:language==='en-US'?'Enter a reporting table name':'请填写上报表名'}, {
  validator:(_:unknown,value?:string) => /^[a-z][a-z0-9_]{0,47}$/.test(value ?? '') && !/^(log|metric|trace)_/.test(value ?? '')
    ? Promise.resolve() : Promise.reject(new Error(language==='en-US'?'Use a logical table name starting with a lowercase letter, without metric_ or similar prefixes, up to 48 characters':'使用小写字母开头的逻辑表名，不带 metric_ 等前缀，最长 48 位')),
}];

export const logicalTableRules=localizedLogicalTableRules();

export const agentIsOnline=(agent:AgentItem,now=Date.now()):boolean=>{
 if(agent.lifecycle_state==='removed')return false;
 const interval=Number(agent.heartbeat?.control_interval_seconds??30),timeout=Math.max(90,Number.isFinite(interval)&&interval>0?interval*3:90);
 return Number.isFinite(Date.parse(agent.last_seen))&&now-Date.parse(agent.last_seen)<=timeout*1000;
};
