import {createLightMoni,withTrace} from '../../sdk/typescript/dist/src/index.js';
const run=process.env.LIGHTMONI_LOGS_RUN??'logs-demo';
const count=Number(process.env.LIGHTMONI_LOGS_COUNT??240);
if(!Number.isSafeInteger(count)||count<1||count>2000)throw new Error('LIGHTMONI_LOGS_COUNT must be 1–2000');
const client=createLightMoni({service:'logs-node-demo',table:process.env.LIGHTMONI_LOGS_TABLE??'acceptance',endpoint:process.env.LIGHTMONI_ENDPOINT??'https://monitor.example.com',key:process.env.LIGHTMONI_KEY});
for(let i=0;i<count;i++){
 const status=i%5===0?500:200;const span=client.startSpan('payment.process');
 await withTrace(span.context,async()=>{
  let body=`${run} Node payment ${String(i).padStart(3,'0')} completed 中文`;
  if(status===500){body+='\nPaymentError: payment rejected\n  at processPayment (payments.ts:42)';span.setError('payment rejected')}
  if(i===0)body+='\n'+'long-log-line: original stack and UTF-8 内容\n'.repeat(300);
  client.log(status===500?'error':'info',body,{run,request_id:`node-${String(i).padStart(3,'0')}`,status,retryable:status===500,empty:'',route:'/payments'});
 });span.end();
}
await client.shutdown({timeoutMs:15000});
console.log(`Node delivered ${count} logs for ${run}; stats:`,client.stats());
