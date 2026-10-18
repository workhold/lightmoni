const uint64 = (value: unknown): bigint => {
  const text = String(value ?? 0);
  if (!/^\d+$/.test(text)) throw Error("invalid distribution count");
  const count = BigInt(text);
  if (count > (1n << 64n) - 1n) throw Error("distribution count overflow");
  return count;
};
export function distributionPoint(point: any, summary = false) {
  const count = uint64(point.count);
  if (!count || !Number.isFinite(point.sum))
    throw Error("distribution requires positive count and finite sum");
  if (summary) {
    if (point.quantileValues?.length)
      throw Error("precomputed quantiles cannot be merged");
    return {
      count: String(count),
      sum: point.sum,
      min: null,
      max: null,
      bounds: [],
      bucket_values: [],
      bucket_counts: [],
      distribution_count: "0",
      distribution_kind: "summary",
      sketch_scale: null,
      quantile_error: null,
      temporality: "DELTA",
    };
  }
  const scale = point.scale ?? 0;
  if (
    !Number.isInteger(scale) ||
    scale < -10 ||
    scale > 20 ||
    (point.zeroThreshold ?? 0) !== 0
  )
    throw Error("invalid exponential histogram scale or zero threshold");
  if (
    !Number.isFinite(point.min) ||
    !Number.isFinite(point.max) ||
    point.min > point.max
  )
    throw Error("distribution requires finite min/max");
  const pairs: [number, string][] = [];
  let total = uint64(point.zeroCount);
  if (total) pairs.push([0, String(total)]);
  for (const [side, sign] of [
    [point.negative, -1],
    [point.positive, 1],
  ] as const) {
    if (!side) continue;
    const counts = side.bucketCounts ?? [],
      offset = side.offset ?? 0;
    if (
      !Array.isArray(counts) ||
      counts.length > 1024 ||
      !Number.isInteger(offset) ||
      offset < -2147483648 ||
      offset > 2147483647
    )
      throw Error("invalid exponential histogram buckets");
    for (const [index, raw] of counts.entries()) {
      const weight = uint64(raw);
      total += weight;
      if (!weight) continue;
      const log2 =
        (offset + index) * 2 ** -scale + 1 - Math.log2(1 + 2 ** -(2 ** -scale));
      const representative = Math.max(
        point.min,
        Math.min(point.max, sign * Math.max(Number.MIN_VALUE, 2 ** log2)),
      );
      if (!Number.isFinite(representative))
        throw Error("invalid histogram representative");
      pairs.push([representative, String(weight)]);
    }
  }
  if (total !== count) throw Error("histogram count mismatch");
  pairs.sort((a, b) => a[0] - b[0]);
  return {
    count: String(count),
    sum: point.sum,
    min: point.min,
    max: point.max,
    bounds: [],
    bucket_values: pairs.map((pair) => pair[0]),
    bucket_counts: pairs.map((pair) => pair[1]),
    distribution_count: String(count),
    distribution_kind: "exponential",
    sketch_scale: scale,
    quantile_error: Math.tanh((Math.LN2 * 2 ** -scale) / 2),
    temporality: "DELTA",
  };
}
