import { isIP } from "node:net";
import { normalizeIPAddress, networkScope } from "../shared/host-network.js";
import { OperationRejectedError } from "./errors.js";
export function privateRegistryAddress(value: unknown): string {
  if (typeof value !== "string" || value.length > 64)
    throw new OperationRejectedError("REGISTRY_PRIVATE_ADDRESS_REQUIRED");
  const v = normalizeIPAddress(value);
  if (v && ['private','loopback'].includes(networkScope(v))) return v;
  throw new OperationRejectedError("REGISTRY_PRIVATE_ADDRESS_REQUIRED");
}
export function registryEndpoint(address: string, port: number): string {
  const ip = privateRegistryAddress(address);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new OperationRejectedError("INVALID_REGISTRY_PORT");
  return `http://${isIP(ip) === 6 ? "[" + ip + "]" : ip}:${port}`;
}
