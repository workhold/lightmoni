import type { Dashboards } from "./dashboards.js";
import { fail } from "../shared/http.js";

const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value) ?? "");
export const DASHBOARD_DETAIL_BYTES = 60 << 10;

/** Shared dashboard reads; persisted Dashboards records remain authoritative. */
export class DashboardReadService {
  constructor(private readonly dashboards: Dashboards) {}
  list(input: any) {
    const scope = input.scope ?? "all";
    if (!["custom", "system", "all"].includes(scope)) fail(400, "invalid_input");
    const customs = this.dashboards.listCustom().map(d => ({...d, kind: "custom"}));
    const systems = this.dashboards.listSystem().map(d => ({...d, kind: "system"}));
    const all = scope === "custom" ? customs : scope === "system" ? systems : [...systems, ...customs];
    const filtered = all.filter(d => !input.search || String(d.title).toLowerCase().includes(input.search.toLowerCase()));
    const offset = input.offset ?? 0, limit = input.limit ?? 30;
    if (!Number.isInteger(offset) || offset < 0 || offset > 100000 || !Number.isInteger(limit) || limit < 1 || limit > 100) fail(400, "invalid_input");
    const items = filtered.slice(offset, offset + limit).map(d => ({id: d.id, title: d.title, revision: d.revision, updated_at: d.updated_at,
      kind: d.kind, panel_count: d.panels?.length ?? 0, variable_count: d.variables?.length ?? 0}));
    return {items, total: filtered.length, offset, limit, has_more: offset + items.length < filtered.length};
  }
  get(id: string) {
    const value = {dashboard: this.dashboards.get(id)};
    if (size(value) > DASHBOARD_DETAIL_BYTES) fail(413, "result_too_large");
    return value;
  }
  versions(id: string) { return {dashboard_id: id, versions: this.dashboards.versions(id)}; }
}
