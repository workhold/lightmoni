import type { OperationResource, OperationsStore } from "./types.js";
import { fail } from "../shared/http.js";

const RESULT_LIMIT = 28 << 10;
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
export interface OperationScheduleReader {
  list(): any[];
  get(id: string): any;
  fires(id: string): any[];
}

function resourceForModel(resource: OperationResource): OperationResource {
  const config = { ...resource.config };
  if (config.static_files && typeof config.static_files === "object") {
    const bodies = Object.values(config.static_files);
    config.static_files_summary = { file_count: bodies.length,
      content_bytes: bodies.reduce<number>((total, body) => total + (typeof body === "string" ? Buffer.byteLength(body) : 0), 0), body_omitted: true };
    delete config.static_files;
  }
  if (config.compose && typeof config.compose === "object") {
    const compose = config.compose;
    config.compose_summary = { service_count: Object.keys(compose.services ?? {}).length,
      services: Object.entries(compose.services ?? {}).map(([name, service]: [string, any]) => ({name, image: service.image})),
      volume_count: Object.keys(compose.volumes ?? {}).length, network_count: Object.keys(compose.networks ?? {}).length,
      document_bytes: size(compose), body_omitted: true };
    delete config.compose;
  }
  return { ...resource, config };
}
function runMetadata(run: Record<string, any>): Record<string, any> {
  return Object.fromEntries(["id", "resource_id", "resource_revision", "operation", "state", "created_at", "expires_at", "created_by", "approved_by", "job_id", "review_url"]
    .filter(key => run[key] !== undefined).map(key => [key, run[key]]));
}
function runForModel(saved: Record<string, any>): Record<string, any> {
  const sensitive = saved.operation === "logs" || saved.receipt?.snapshot?.operations?.data?.sensitive_logs;
  const run = structuredClone(sensitive ? {...saved, receipt: null} : saved);
  if (sensitive) run.receipt_omitted = "Sensitive application logs are available only in the administrator review UI.";
  if (run.preview?.resource) run.preview.resource = resourceForModel(run.preview.resource);
  const data = run.receipt?.snapshot?.operations?.data;
  const fields = ["backups", "removed", "versions", "containers", "discovered_containers", "volumes", "networks", "history"];
  const original = new Map<string, number>();
  if (data && typeof data === "object") {
    for (const key of fields) if (Array.isArray(data[key])) original.set(key, data[key].length);
    const omissions: Record<string, {received: number; returned: number}> = {};
    while (size({run}) > RESULT_LIMIT) {
      const key = fields.filter(field => Array.isArray(data[field]) && data[field].length).sort((a, b) => size(data[b]) - size(data[a]))[0];
      if (!key) break;
      const count = Math.floor(data[key].length / 2);
      data[key] = key === "history" ? count ? data[key].slice(-count) : [] : data[key].slice(0, count);
      omissions[key] = {received: original.get(key)!, returned: count}; run.model_truncated_lists = omissions;
    }
  }
  if (size({run}) <= RESULT_LIMIT) return run;
  return {...runMetadata(run), details_omitted: "Details exceed the model context limit; inspect the administrator review URL."};
}
function page(items: any[], input: any, max = 100) {
  const offset = input.offset ?? 0, limit = input.limit ?? Math.min(30, max);
  if (!Number.isInteger(offset) || offset < 0 || offset > 100000 || !Number.isInteger(limit) || limit < 1 || limit > max) fail(400, "invalid_input");
  const selected = items.slice(offset, offset + limit);
  while (selected.length > 1 && size({items: selected}) > RESULT_LIMIT) selected.pop();
  return {items: selected, total: items.length, offset, limit, has_more: offset + selected.length < items.length};
}

/** Shared safe operations read models; native stores remain authoritative. */
export class OperationsReadService {
  constructor(private readonly store: OperationsStore, private readonly schedules?: OperationScheduleReader) {}
  listResources(input: any) {
    const offset = input.offset ?? 0, limit = input.limit ?? 20;
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 50) fail(400, "invalid_input");
    const saved = this.store.list(input.kind), resources = saved.slice(offset, offset + limit).map(resourceForModel);
    const result = () => ({resources, total: saved.length, offset, limit, returned: resources.length,
      next_offset: offset + resources.length < saved.length ? offset + resources.length : null, model_truncated: resources.length < Math.min(limit, Math.max(0, saved.length - offset))});
    while (resources.length > 1 && size(result()) > RESULT_LIMIT) resources.pop();
    if (resources.length && size(result()) > RESULT_LIMIT) resources[0] = {...resources[0], config: {details_omitted: "Configuration exceeds the model context limit; inspect it in the administrator UI."}};
    return result();
  }
  getResource(id: string) {
    const value = {resource: resourceForModel(this.store.get(id))};
    if (size(value) > RESULT_LIMIT) fail(413, "result_too_large");
    return value;
  }
  listRuns(resourceID: string | undefined, input: any) { return page(this.store.runs(resourceID).map(runMetadata), input); }
  getRun(id: string) { return {run: runForModel(this.store.getRun(id))}; }
  metadata(run: Record<string, any>) { return runMetadata(run); }
  listSchedules(input: any) {
    if (!this.schedules) fail(404, "resource_not_found");
    return page(this.schedules.list(), input);
  }
  getSchedule(id: string) {
    if (!this.schedules) fail(404, "resource_not_found");
    const value = {schedule: this.schedules.get(id), fires: this.schedules.fires(id)};
    if (size(value) > RESULT_LIMIT) fail(413, "result_too_large");
    return value;
  }
}
