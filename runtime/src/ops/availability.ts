import type { DB } from '../shared/sqlite.js';
import type { PlatformResource } from './types.js';

type Row = Record<string, any>;
export const minimumAvailable = (a: PlatformResource) =>
  Math.ceil(Number(a.spec.replicas ?? 0) * Number(a.spec.min_available_percent ?? 60) / 100);
export const graceMilliseconds = (a: PlatformResource) => Number(a.spec.heartbeat_grace_minutes ?? 5) * 60000;

/** Persist membership separately from observations: a protected address is not proof of readiness. */
export function createAvailability(db: DB, now: () => Date, agent: (id: string) => Row | undefined,
  machineAgent: (id: string) => string) {
  const columns = new Set(db.all<Row>('PRAGMA table_info(ops_cluster_instances)').map(c => c.name));
  for (const [name, definition] of Object.entries({serving:'INTEGER NOT NULL DEFAULT 0',last_ready_at:"TEXT NOT NULL DEFAULT ''",failure_since:"TEXT NOT NULL DEFAULT ''",retire_after:"TEXT NOT NULL DEFAULT ''"}))
    if (!columns.has(name)) db.exec(`ALTER TABLE ops_cluster_instances ADD COLUMN ${name} ${definition}`);
  // Only a confirmed successful observation may seed membership on upgrade.
  db.run("UPDATE ops_cluster_instances SET last_ready_at=last_seen,serving=1 WHERE last_ready_at='' AND healthy=1 AND state='running' AND retired=0 AND desired_state='running'");
  const identity = (i: Row) => !!agent(i.agent_id) && machineAgent(i.machine_id) === i.agent_id;
  const current = (i: Row, a: PlatformResource) => identity(i) && !i.retired && i.desired_state === 'running' &&
    i.state === 'running' && i.healthy === 1 &&
    now().getTime() - Date.parse(agent(i.agent_id)!.last_seen) < 120000 &&
    now().getTime() - Date.parse(i.last_seen) < Math.max(120000, Number(a.spec.health?.interval_seconds ?? 30) * 2000);
  function refresh(a: PlatformResource, instances: Row[]) {
    const managed = a.spec.deployment_mode === 'managed', clock = now().getTime();
    const result: (Row & {ready: boolean; availability: string})[] = instances.map(source => {
      const i = {...source}, ready = current(i, a);
      if (ready) {
        i.last_ready_at = i.last_seen;
        i.failure_since = '';
        i.serving = 1;
      } else if (!identity(i) || i.retired || i.desired_state !== 'running' || managed && i.state === 'removed') {
        i.serving = 0;
      } else {
        if (!i.failure_since) {
          const times = [Date.parse(i.last_seen), Date.parse(agent(i.agent_id)?.last_seen ?? '')].filter(Number.isFinite);
          i.failure_since = new Date(times.length ? Math.min(...times) : clock).toISOString();
        }
        // Manual membership follows human intent, independently of health. This
        // also restores members withdrawn by the former health-only policy.
        if (!managed) i.serving = i.last_ready_at ? 1 : 0;
      }
      // A replacement is never advertised until promotion to its real slot.
      if (String(i.slot).startsWith('surge-')) i.serving = 0;
      return {...i, ready, availability: ready ? 'ready' : 'unavailable'};
    });
    let count = result.filter(i => i.serving).length;
    const floor = managed ? minimumAvailable(a) : 0;
    for (const i of result) {
      if (!i.serving || i.ready) continue;
      if (!managed) { i.availability = 'retained'; continue; }
      if (clock - Date.parse(i.failure_since) < graceMilliseconds(a)) i.availability = 'grace';
      else if (count > floor) { i.serving = 0; count--; }
      else i.availability = 'protected';
    }
    for (const i of result) {
      const old = instances.find(v => v.id === i.id)!;
      if (old.serving === i.serving && old.last_ready_at === i.last_ready_at && old.failure_since === i.failure_since) continue;
      db.run('UPDATE ops_cluster_instances SET serving=?,last_ready_at=?,failure_since=? WHERE id=?',i.serving,i.last_ready_at,i.failure_since,i.id);
    }
    return result;
  }
  return {current, refresh};
}
