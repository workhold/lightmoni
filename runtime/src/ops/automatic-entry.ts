import { createHash } from 'node:crypto';
import type {PlatformStore} from './types.js';
import {fail} from '../shared/http.js';

/** The selected zone persists with the deployment; cluster identity keeps names stable. */
export function automaticEntry(store:PlatformStore,clusterID:string,zoneID?:string) {
 const zones=store.list('dns_zone').sort((a,b)=>String(a.spec.scope).localeCompare(String(b.spec.scope))||a.id.localeCompare(b.id));
 const zone=zoneID?store.get(zoneID,'dns_zone'):zones[0];
 if(!zone)return {};
 const prefix='edge-'+createHash('sha256').update(clusterID).digest('hex').slice(0,16);
 const domain=prefix+'.'+zone.spec.scope;
 if(domain.length>253)fail(400,'gateway_dns_scope_too_long');
 return {gateway_domain:domain,gateway_dns_zone_id:zone.id,gateway_domain_generated:true};
}
