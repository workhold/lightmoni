export interface TimeRange {from:string;to:string}
export interface Parameter {type:string;value:unknown}
export interface SQLQuery {refId:string;sql:string;params?:Record<string,Parameter>}
export interface QueryRequest {request_id:string;range:TimeRange;interval_ms:number;queries:SQLQuery[];source?:string}
export interface Column {name:string;type:string;nullable?:boolean}
export interface QueryFrame {columns:Column[];rows:unknown[][];meta?:Record<string,unknown>}
export interface QueryResult {refId:string;status:'success'|'empty'|'error'|'cancelled';frames:QueryFrame[];complete:boolean;truncated:boolean;elapsed_ms:number;error?:string}
export interface QueryResponse {request_id:string;results:QueryResult[]}
export interface CatalogTable {system?:boolean;id:string;name:string;logical_name:string;kind:'log'|'metric'|'trace';metric_type?:string;columns:Column[];services:string[];alert_group_id?:string;retention_days?:number|null;effective_retention_days?:number}
export interface User {id:string;name:string;role:'admin'|'member';nickname?:string;avatar_url?:string}
export const frameRows = (frame:QueryFrame):Record<string,unknown>[] => frame.rows.map(row => Object.fromEntries(frame.columns.map((column,index)=>[column.name,row[index]])));
