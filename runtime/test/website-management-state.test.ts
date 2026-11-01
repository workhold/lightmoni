import {test} from 'node:test';
import assert from 'node:assert/strict';
import {websitePublication,websiteDNS,entryDNS} from '../../web/src/app/ops/website-state.js';

const site=(status:any={},spec:any={})=>({id:'site',kind:'website',revision:3,spec:{cluster_ids:['a','b'],bindings:[{domains:['www.example.test'],dns_enabled:true}],...spec},status}) as any;
const active={desired_revision:2,enabled:true,active:true,synchronized:true,phase:'active'};
test('publication status distinguishes saved, partial, failed, unknown, disabled and synchronized receipts',()=>{
 assert.equal(websitePublication(site({deployments:{a:{phase:'pending',desired_revision:0}}})).key,'unpublished');
 assert.equal(websitePublication(site({deployments:{a:active}})).key,'partial');
 assert.equal(websitePublication(site({deployments:{a:active,b:active}})).key,'published');
 assert.equal(websitePublication(site({deployments:{a:{...active,synchronized:false},b:active}})).key,'partial');
 assert.equal(websitePublication(site({deployments:{a:{...active,phase:'unknown'},b:active}})).key,'unknown');
 assert.equal(websitePublication(site({deployments:{a:{...active,active:false,phase:'failed',last_error:'failed'}}})).key,'failed');
 assert.equal(websitePublication(site({deployments:{a:{...active,enabled:false}}})).key,'disabled');
 assert.equal(websitePublication(site({actual_cluster_ids:[],deployments:{a:{...active,enabled:false}}})).key,'disabled');
 assert.equal(websitePublication(site({actual_cluster_ids:[],deployments:{a:{...active,enabled:false}}},{routing_mode:'managed',cluster_ids:undefined})).key,'disabled');
 assert.equal(websitePublication(site({actual_cluster_ids:['a'],deployments:{a:active}})).key,'partial');
 // A policy-only revision increment is not evidence of an unpublished content change.
 assert.equal(websitePublication(site({deployments:{a:active,b:active}})).key,'published');
});
test('DNS eligibility, publication and recent provider readback are separate facts',()=>{
 assert.equal(websiteDNS(site()).key,'not_published');
 assert.equal(websiteDNS(site({}, {bindings:[{dns_enabled:false}]})).key,'external');
 const status={deployments:{a:active,b:active},cluster_traffic:{a:{eligible:true}},dns_signature:'observed',dns_updated_at:'2026-11-01',dns:[{verified:true}]};
 assert.equal(websiteDNS(site(status)).key,'verified');
 assert.match(websiteDNS(site(status)).hint[0],/公网缓存传播未检查/);
 assert.equal(websiteDNS(site({...status,dns:[]})).key,'pending');
 assert.equal(websiteDNS(site({...status,cluster_traffic:{a:{error:'machine_public_service_address_required'}}})).key,'blocked');
 assert.equal(websiteDNS(site({...status,dns_error:'dns_line_not_supported'})).key,'error');
 assert.equal(websiteDNS(site(status,{cluster_policies:[{cluster_id:'a',enabled:false}]}),'a').key,'traffic_off');
});
test('entry DNS makes external maintenance and missing public service addresses explicit',()=>{
 const app:any={id:'entry',status:{deployments:{a:{enabled:true}},gateway_dns:{a:{state:'public_ip_required'}}}};
 assert.equal(entryDNS(app,{cluster_id:'a'}).key,'missing');
 assert.equal(entryDNS(app,{cluster_id:'a',gateway_domain:'edge.example.test'}).key,'external');
 assert.equal(entryDNS(app,{cluster_id:'a',gateway_domain:'edge.example.test',gateway_dns_zone_id:'zone'}).key,'public_ip_required');
});
