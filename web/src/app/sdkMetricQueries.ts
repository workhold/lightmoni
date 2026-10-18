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
  return `WITH
  source AS (
    SELECT * FROM metric_${table}_histogram
    WHERE service=${literal(service)} AND env=${literal(env)}
      AND event_time >= now() - INTERVAL ${minutes} MINUTE
  ),
  totals AS (
    SELECT metric_name, key1, key2,
      sum(sample_count) AS samples, sum(value_sum) AS total_value,
      sum(distribution_count) AS known_samples,
      min(value_min) AS low, max(value_max) AS high,
      max(quantile_error) AS relative_error_bound
    FROM source GROUP BY metric_name, key1, key2
  ),
  distribution AS (
    SELECT metric_name, key1, key2,
      quantilesExactWeighted(0.005,0.05,0.10,0.30,0.50,0.70,0.90,0.95,0.995)(v,n) AS p
    FROM source ARRAY JOIN bucket_values AS v, bucket_counts AS n
    GROUP BY metric_name, key1, key2
  )
SELECT t.metric_name, t.key1, t.key2,
  t.samples AS sample_count, t.total_value,
  t.total_value / nullIf(t.samples,0) AS average_value,
  t.samples / ${minutes * 60}.0 AS samples_per_second,
  if(t.known_samples=t.samples,t.low,NULL) AS minimum_value,
  if(t.known_samples=t.samples,t.high,NULL) AS maximum_value,
  if(t.known_samples=t.samples,'complete','incomplete_distribution') AS distribution_status,
  t.relative_error_bound,
  mapFromArrays(
    ['P005','P05','P10','P30','P50','P70','P90','P95','P995'],
    arrayMap(q -> if(t.known_samples=t.samples,
      greatest(t.low,least(t.high,q)),CAST(NULL AS Nullable(Float64))),
      if(empty(d.p),[0.,0.,0.,0.,0.,0.,0.,0.,0.],d.p))
  ) AS percentiles
FROM totals AS t LEFT JOIN distribution AS d USING(metric_name,key1,key2)
ORDER BY t.metric_name,t.key1,t.key2`;
}
