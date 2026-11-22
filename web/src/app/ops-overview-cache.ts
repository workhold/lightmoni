import type {Overview} from './ops/model';

let cache:Overview|undefined;

export function readOpsOverviewCache():Overview|undefined{return cache}
export function writeOpsOverviewCache(value:Overview){cache=value}
export function clearOpsOverviewCache(){cache=undefined}
