const literal = (value: string) => "'" + value.replaceAll("'", "''") + "'";
export function sdkMetricQuery(
  table = "your_table",
  service = "order-api",
  env = "test",
  minutes = 5,
) {
  if (
    !/^[a-z][a-z0-9_]{0,47}$/.test(table) ||
    !Number.isInteger(minutes) ||
    minutes < 1 ||
    minutes > 1440
  )
    throw new Error("invalid query example");
  return `SELECT
  metric_name, key1, key2,
  sum(\`count\`) AS sample_count,
  sum(\`value\`) AS total_value,
  sum(\`value\`) / nullIf(sum(\`count\`),0) AS average_value,
  sum(\`count\`) / ${minutes*60}.0 AS samples_per_second,
  metric_min(distribution) AS minimum_value,
  metric_max(distribution) AS maximum_value,
  if(sum(distribution_count)=sum(\`count\`),'complete','incomplete_distribution') AS distribution_status,
  max(quantile_error) AS relative_error_bound,
  map('P005',p005(distribution),'P05',p05(distribution),
      'P10',p10(distribution),'P30',p30(distribution),
      'P50',p50(distribution),'P70',p70(distribution),
      'P90',p90(distribution),'P95',p95(distribution),
      'P995',p995(distribution)) AS percentiles
FROM ${table}
WHERE service=${literal(service)} AND env=${literal(env)}
  AND window_start >= toStartOfInterval(now(),INTERVAL 30 SECOND) - INTERVAL ${minutes} MINUTE
  AND window_start < toStartOfInterval(now(),INTERVAL 30 SECOND)
GROUP BY metric_name,key1,key2
ORDER BY metric_name,key1,key2`;
}
