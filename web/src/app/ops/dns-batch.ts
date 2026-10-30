import {ApiError} from '../../shared/api';
import type {Run, Spec} from './model';

export const DNS_BATCH_LIMIT = 50;
export const DNS_TYPES = ['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'CAA', 'NS', 'SRV', 'HTTPS', 'SVCB', 'SPF'];
export type BatchAction = 'create_record' | 'update_record' | 'delete_record';
export type BatchState = 'waiting' | 'running' | 'succeeded' | 'failed' | 'verifying' | 'unknown' | 'skipped';
export type BatchItem = {key: string; record: Spec; original?: Spec; state: BatchState; detail?: string};
export type DNSResponse = {run?: Run; result?: Spec};
export const recordID = (record: Spec) => String(record.id ?? record.provider_record_id ?? '');
export const splitValues = (text: string): string[] => [...new Set(text.split(/\r?\n/).filter(value => value.trim().length > 0))];

export function batchItems(action: BatchAction, records: Spec[], values: Spec, validate = true): BatchItem[] {
  let items: BatchItem[];
  if (action === 'create_record') {
    const {values: text = '', ...shared} = values;
    if (shared.line === '') delete shared.line;
    items = splitValues(text).map((value, index) => ({key: String(index), record: {...shared, value}, state: 'waiting'}));
  } else {
    if (validate && action === 'update_record' && !values.changeType && !values.changeValue) throw Error('dns_batch_fields_required');
    items = records.map(record => ({
      key: recordID(record), original: {...record}, state: 'waiting',
      record: {...record, id: recordID(record), ...(action === 'update_record' ? {
        ...(values.changeType ? {type: values.type} : {}), ...(values.changeValue ? {value: values.value} : {}),
      } : {})},
    }));
  }
  if (validate && (!items.length || items.length > DNS_BATCH_LIMIT)) throw Error('dns_batch_count_invalid');
  return items;
}

export function dnsOutcome(response: DNSResponse): {state: BatchState; detail?: string} {
  const run = response.run, result = run?.result ?? response.result ?? {};
  const detail = String(result.error ?? result.code ?? '');
  if (run?.state === 'unknown') return {state: 'unknown', detail};
  if (run?.state === 'failed') return {state: 'failed', detail};
  if (run?.state === 'verifying' || result.state === 'verifying' || result.verified === false) return {state: 'verifying', detail};
  if (run?.state === 'succeeded') return {state: 'succeeded'};
  return {state: 'unknown', detail};
}

// Each request has its own server-side authorization, scope checks and audit run.
export async function executeDNSBatch(items: BatchItem[], request: (item: BatchItem) => Promise<DNSResponse>,
  update: (items: BatchItem[]) => void, shouldStop: () => boolean): Promise<BatchItem[]> {
  const results = items.map(item => ({...item}));
  let halted = false;
  for (const item of results) {
    if (halted || shouldStop()) {item.state = 'skipped'; update([...results]); continue;}
    item.state = 'running'; update([...results]);
    try {Object.assign(item, dnsOutcome(await request(item)));}
    catch (error) {
      const status = error instanceof ApiError ? error.status : 0;
      item.state = status >= 400 && status < 500 ? 'failed' : 'unknown';
      item.detail = error instanceof Error ? error.message : String(error);
      halted = [401, 403, 409].includes(status);
    }
    update([...results]);
  }
  return results;
}
