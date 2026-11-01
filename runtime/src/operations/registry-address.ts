import { isIP } from "node:net";
import { OperationRejectedError } from "./errors.js";
export function privateRegistryAddress(value: unknown): string {
  if (typeof value !== "string" || value.length > 64)
    throw new OperationRejectedError("REGISTRY_PRIVATE_ADDRESS_REQUIRED");
  const v = value.toLowerCase();
  if (isIP(v) === 4) {
    const [a, b] = v.split(".").map(Number);
    if (
      a === 127 ||
      a === 10 ||
      (a === 192 && b === 168) ||
      (a === 172 && Number(b) >= 16 && Number(b) <= 31)
    )
      return v;
  }
  if (isIP(v) === 6 && (v === "::1" || /^(fc|fd)/.test(v))) return v;
  throw new OperationRejectedError("REGISTRY_PRIVATE_ADDRESS_REQUIRED");
}
export function registryEndpoint(address: string, port: number): string {
  const ip = privateRegistryAddress(address);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new OperationRejectedError("INVALID_REGISTRY_PORT");
  return `http://${isIP(ip) === 6 ? "[" + ip + "]" : ip}:${port}`;
}
