import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';

// Explicitly mocked external DNS transport. Runtime ownership, reconciliation,
// record aggregation and removal still execute through the production provider.
export async function createMockDNS(root){
  const path=join(root,'mock-dns.json');
  let records;
  try{records=JSON.parse(await readFile(path,'utf8'));}
  catch{records=[{RecordId:'1',RR:'mail',Type:'MX',Value:'external.mail.example.test',TTL:600,Status:'ENABLE'}];}
  let next=Math.max(...records.map(record=>Number(record.RecordId)),1)+1;
  const persist=()=>writeFile(path,JSON.stringify(records,null,2)+'\n',{mode:0o600});
  await persist();
  const fetcher=async(url,init)=>{
    if(!new URL(url).hostname.endsWith('.aliyuncs.com'))throw Error('Real provider network is disabled in this QA demo');
    const data=Object.fromEntries(new URLSearchParams(String(init?.body)));
    let response;
    if(data.Action==='DescribeDomainRecords')response={TotalCount:records.length,DomainRecords:{Record:records}};
    else if(data.Action==='AddDomainRecord'){
      const record={RecordId:String(next++),RR:data.RR,Type:data.Type,Value:data.Value,TTL:Number(data.TTL),Status:'ENABLE'};
      records.push(record);response={RecordId:record.RecordId};await persist();
    }else if(data.Action==='UpdateDomainRecord'){
      const record=records.find(item=>item.RecordId===data.RecordId);if(!record)throw Error('Mock DNS record not found');
      Object.assign(record,{RR:data.RR,Type:data.Type,Value:data.Value,TTL:Number(data.TTL)});response={RecordId:record.RecordId};await persist();
    }else if(data.Action==='DeleteDomainRecord'){
      records=records.filter(item=>item.RecordId!==data.RecordId);response={};await persist();
    }else if(data.Action==='SetDomainRecordStatus'){
      const record=records.find(item=>item.RecordId===data.RecordId);if(record)record.Status=data.Status;response={};await persist();
    }else throw Error('Unsupported external action in mock DNS');
    return new Response(JSON.stringify(response),{status:200,headers:{'content-type':'application/json'}});
  };
  return {fetch:fetcher,records:()=>structuredClone(records)};
}
