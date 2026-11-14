import { createHash } from "node:crypto";
const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export function capabilityDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
export interface CapabilityIdempotencyPolicy {
  installationID: string;
  capability: string;
  key: string;
}
