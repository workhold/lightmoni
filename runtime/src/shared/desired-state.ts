import { createHash } from 'node:crypto';

/** Stable JSON for content comparison; array order remains meaningful. */
export function desiredJSON(value: unknown): string {
  const normalize = (v: any): any => {
    if (Array.isArray(v)) return v.map(normalize);
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => [k, normalize(v[k])]));
    return v;
  };
  return JSON.stringify(normalize(value));
}
export const desiredHash = (value: unknown) => createHash('sha256').update(desiredJSON(value)).digest('hex');
export const managedResourceID = (provider: string, machine: string, agent: string, key: string) => desiredHash([provider, machine, agent, key]);
