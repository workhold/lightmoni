import { parse, stringify, LosslessNumber } from "lossless-json";
export function parseJSON<T = any>(source: string): T {
  return parse(source, undefined, (value) => {
    if (/^-?\d+$/.test(value)) {
      const num = Number(value);
      return Number.isSafeInteger(num) ? num : new LosslessNumber(value);
    }
    return Number(value);
  }) as T;
}
export function stringifyJSON(value: any): string {
  return (
    stringify(value, (_key, v) => (typeof v === "bigint" ? v.toString() : v)) ??
    "null"
  );
}
export function integerString(value: any): string {
  return value instanceof LosslessNumber ? value.value : String(value);
}
export function plainJSON<T = any>(value: T): T {
  return JSON.parse(stringifyJSON(value));
}
