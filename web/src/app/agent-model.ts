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
export type AgentTaskType = 'host'|'probe'|'log';
export const agentTaskTypes:{value:AgentTaskType;label:string}[] = [
  {value:'host',label:'指标采集'},{value:'probe',label:'服务拨测'},{value:'log',label:'目录日志'},
];
export const taskTypeName = (type:AgentTaskType) => agentTaskTypes.find(item=>item.value===type)?.label ?? type;
export interface AgentTaskLabel {id:string;name:string;node_count:number;task_count:number}
export interface ManagedAgentTask {id:string;name:string;type:AgentTaskType;enabled:boolean;label_ids:string[];config:AgentTasks}
export interface AgentItem {
  id:string;hostname:string;platform:string;arch:string;version:string;last_seen:string;
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
  name?:string;type?:AgentTaskType;enabled?:boolean;label_ids?:string[];
  probes:(Omit<ProbeTask,'timeout_ms'|'expected_status'> & {timeout_seconds:number;expected_status:string[]})[];
}
export const taskFormValues = (tasks:AgentTasks):TaskForm => ({...normalizeTasks(tasks),
  probes:(tasks.probes ?? []).map(probe => ({...probe,timeout_seconds:probe.timeout_ms/1000,expected_status:(probe.expected_status ?? []).map(String)})),
});
export const taskPayload = (values:TaskForm):AgentTasks => ({...(({name:_,type:__,enabled:___,label_ids:____,...rest}) => rest)(values),
  host_table:'host',probe_table:'probe',
  log_table:'files',log_sources:(values.log_sources ?? []).map(source => ({...source,directory:source.directory.trim(),pattern:source.pattern.trim() || '*.log*'})),
  process_names:(values.process_names ?? []).map(name => name.trim()),
  probes:(values.probes ?? []).map(({timeout_seconds,expected_status,...probe}) => ({...probe,
    id:probe.id.trim(),target:probe.target.trim(),timeout_ms:Math.round(timeout_seconds*1000),
    expected_status:probe.kind === 'http' ? (expected_status ?? []).map(Number) : [],
  })),
});
export const logicalTableRules = [{required:true,message:'请填写上报表名'}, {
  validator:(_:unknown,value?:string) => /^[a-z][a-z0-9_]{0,47}$/.test(value ?? '') && !/^(log|metric|trace)_/.test(value ?? '')
    ? Promise.resolve() : Promise.reject(new Error('使用小写字母开头的逻辑表名，不带 metric_ 等前缀，最长 48 位')),
}];

export const agentIsOnline=(agent:AgentItem,now=Date.now()):boolean=>{
 const interval=Number(agent.heartbeat?.control_interval_seconds??30),timeout=Math.max(90,Number.isFinite(interval)&&interval>0?interval*3:90);
 return Number.isFinite(Date.parse(agent.last_seen))&&now-Date.parse(agent.last_seen)<=timeout*1000;
};
