import {parse} from '@clickhouse/parser';
const percentiles:Record<string,number>={p005:.005,p05:.05,p10:.1,p30:.3,p50:.5,p70:.7,p90:.9,p95:.95,p995:.995};
// These are AST macros, not string replacements. Nested queries, aliases and
// qualified distribution columns retain the ordinary SQL authorization pass.
export function expandMetricFunctions(node:any):any{
 if(!node||typeof node!=='object')return node;
 if(Array.isArray(node))return node.map(expandMetricFunctions);
 for(const [k,v]of Object.entries(node))if(k!=='location'&&k!=='parent')node[k]=expandMetricFunctions(v);
 if(node.type!=='Function')return node;const name=String(node.name).toLowerCase();
 if(!(name in percentiles)&&!['metric_min','metric_max'].includes(name))return node;
 if(node.arguments?.length!==1||node.parameters?.length)throw Error(name+' requires one distribution argument');
 const arg=node.arguments[0],d=(n:number)=>`tupleElement(__lm_dist_arg,${n})`,valid=`sum(${d(3)})>0 AND sum(${d(3)})=sum(${d(4)})`;
 const value=name==='metric_min'?`min(${d(5)})`:name==='metric_max'?`max(${d(6)})`:`greatest(min(${d(5)}),least(max(${d(6)}),quantileExactWeightedArray(${percentiles[name]})(${d(1)},${d(2)})))`;
 const expression=(parse(`SELECT if(${valid},${value},CAST(NULL AS Nullable(Float64)))`,{locations:false}) as any[])[0].selects[0].select[0];
 const substitute=(n:any):any=>{if(!n||typeof n!=='object')return n;if(n.type==='Identifier'&&n.name==='__lm_dist_arg')return structuredClone(arg);if(Array.isArray(n))return n.map(substitute);for(const[k,v]of Object.entries(n))n[k]=substitute(v);return n;};
 const result=substitute(expression);if(node.alias)result.alias=node.alias;return result;
}
export function metricTableNames(tables:any[]){return new Set(tables.flatMap(t=>t.kind==='metric'&&t.metric_type==='histogram'&&!t.system?[t.name,t.logical_name]:[t.name]));}
