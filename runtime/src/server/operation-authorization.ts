import type { OperationPayload } from '../operations/types.js';
import type { Dependencies } from '../shared/types.js';
import { canonicalJSON } from '../shared/privileged-executor.js';
import { fail } from '../shared/http.js';

/** The sealed payload retains its schedule origin even if its fire or schedule
 * is deleted. A missing source must never turn scheduled work into manual work. */
export function validateOperationAuthorization(deps: Dependencies, payload: OperationPayload, run: Record<string, any>) {
  const source = payload.authorization;
  if (!source) return;
  const reject = () => fail(403, 'schedule_authorization_changed');
  if (source.kind !== 'schedule' || !['scheduled', 'manual'].includes(source.trigger)
    || !Number.isSafeInteger(source.revision) || source.revision < 1
    || source.actor !== run.approved_by || source.actor !== run.created_by) reject();
  if (!deps.db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='ops_schedules'")) reject();
  const schedule = deps.db.get<Record<string, any>>('SELECT * FROM ops_schedules WHERE id=?', source.schedule_id);
  const fire = deps.db.get<Record<string, any>>('SELECT * FROM ops_schedule_fires WHERE schedule_id=? AND run_id=?', source.schedule_id, run.id);
  if (!schedule || !fire || schedule.revision !== source.revision || fire.schedule_revision !== source.revision
    || schedule.authorized_by !== source.authorized_by || schedule.disabled_reason
    || source.trigger === 'scheduled' && !schedule.enabled
    || schedule.resource_id !== payload.resource.id || schedule.resource_revision !== payload.resource.revision
    || schedule.operation !== payload.operation || fire.state === 'unknown'
    || canonicalJSON(JSON.parse(deps.decrypt(schedule.input_json))) !== canonicalJSON(payload.input)
    || !deps.db.get("SELECT id FROM users WHERE id=? AND role='admin' AND active=1", source.authorized_by)) reject();
}
