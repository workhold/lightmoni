import type {QueryResult} from '../../shared/types';

// Request IDs and execution durations belong to the inspector, not chart data.
export function chartDataSignature(results:QueryResult[]):string {
  return JSON.stringify(results.map(({refId,status,error,frames,complete,truncated})=>({refId,status,error,frames,complete,truncated})));
}

export function retainHiddenSeries(previous:string[],series:string[]):string[] {
  const next=previous.filter(name=>series.includes(name));
  return next.length===previous.length?previous:next;
}
