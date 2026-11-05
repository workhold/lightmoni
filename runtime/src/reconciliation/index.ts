import type { Dependencies, Handler } from '../shared/types.js';
import { fail, HTTPError } from '../shared/http.js';
import { ReconciliationRegistry } from './registry.js';
export { ReconciliationRegistry } from './registry.js';

export function registerReconciliation(deps: Dependencies) {
  const registry=new ReconciliationRegistry(deps);
  const safe=(fn:Handler):Handler=>async c=>{
    c.res.setHeader('Cache-Control','no-store');
    try{deps.auth.requireAdmin(c);await fn(c);}
    catch(e){if(e instanceof HTTPError)c.json({error:e.message},e.status);else c.json({error:'reconciliation_request_failed'},500);}
  };
  const machine=(id:string)=>{if(!deps.db.get('SELECT id FROM managed_machines WHERE id=?',id))fail(404,'machine_not_found');};
  const pagination=(v:string|null,fallback:number,max:number)=>{const n=v===null?fallback:Number(v);if(!Number.isSafeInteger(n)||n<0||n>max)fail(400,'invalid_reconciliation_pagination');return n;};
  deps.router.get('/api/v1/reconciliation/providers',safe(c=>c.json({providers:registry.catalog()})));
  deps.router.get('/api/v1/machines/:id/reconciliation',safe(c=>{
    machine(c.params.id);registry.refresh();const limit=pagination(c.url.searchParams.get('limit'),100,1000);if(!limit)fail(400,'invalid_reconciliation_pagination');
    c.json(registry.inventory(c.params.id,limit,pagination(c.url.searchParams.get('offset'),0,1000000)));
  }));
  deps.router.post('/api/v1/machines/:id/reconciliation',safe(async c=>{
    machine(c.params.id);const body=await c.body();if(body&&Object.keys(body).length)fail(400,'reconciliation_input_not_supported');
    registry.refresh();registry.request(c.params.id);await registry.tick();c.json(registry.inventory(c.params.id),202);
  }));
  return registry;
}
