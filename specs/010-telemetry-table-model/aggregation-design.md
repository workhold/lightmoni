# 固定维度与自动聚合实现

状态：2026-10-19 功能分支实现；最终契约见 contracts/runtime.md，验收见 docs/evidence/telemetry-table-model。

## 用户只记录观察

```javascript
const moni = createLightMoni({ service: 'order-api', env: 'prod' });
moni.record('database', 'db.query.duration_ms', {key1: 'mysql', key2: 'select'}, 128, 1);
moni.record('restaurant', 'customer.spend', {key1: 'store-a'}, 100, 5);
```

table 与 metric_name 在调用时传入，一个客户端可写多个表、多个指标。service/env 在初始化时固定，可选 service_version/instance_id。count 必填：第一例表示一次请求耗时 128ms；第二例表示 5 人总消费 100，平均消费 20。

key1…key16 是固定 String 列，不随业务维度含义扩列。同一 (table,metric_name) 应保持槽位含义一致，并在业务指标文档中说明；不同 metric_name 可分别把 key1/key2 用作 isp/province 或 country/asn。单位放入有含义的 metric_name（如 duration_ms），不要求用户注册 instrument。

## 有界聚合与传输

本地组键仅包含 table、metric_name 与排序后非空 key 槽；service/env 在同一状态内不变。默认最多 2000 个活跃组，受总 bufferBytes 限制，新增桶计入容量。用户应避免 request_id/user_id 等无界维度。诊断沿用 SDK 的 invalid/overflow/dropped 状态。

count=1 的值进入指数直方图：保留 count/sum/min/max、零数量、正/负桶，默认 scale=8，每侧连续跨度最多 1024 桶。范围增大时按 floor(index/2) 降低 scale，四 SDK 使用一致规则。上报标准 OTLP ExponentialHistogram DELTA，10 秒自动收集，shutdown 收集剩余数据。业务自动收集独立于 SDK 自身遥测开关。

count>1 的输入只增加 summary_count/summary_sum，同组窗口另发 OTLP Summary，无 quantileValues。只知道人数和总额无法恢复每人的消费，不能从 100/5 推断五人都消费 20，也不能据此构造 min/max/P95。

重试复用冻结的原批次和窗口，中心持久确认后才移除；ReplacingMergeTree 的公开 FINAL 视图负责幂等去重。没有在未去重输入上添加增量物化视图，避免丢 ACK 重试重复累计。

## 每行与查询

每行包含固定身份/维度列、时间窗口、统计与分布：sample_count、value_sum、value_min/value_max、bucket_values/bucket_counts、distribution_count、distribution_kind、sketch_scale、quantile_error。资源与属性原文仍保留以兼容旧查询；env/service_version/key1…key16 是实际固定列，历史行由 DEFAULT 表达式从原资源/属性读取。

中心将指数桶映射为桶内代表值与频次。分位数使用 quantilesExactWeighted 合并所有窗口/实例的压缩分布；该函数对代表值分布精确，对原始观察近似。指数桶相对误差界为 tanh(ln(2) * 2^(-scale) / 2)，最终查询显示合并行最大 quantile_error；精度取决于范围和最终 scale。代表值与分位数限制在已知真实 min/max 内，不承诺固定 1% 精度。

查询 SQL 由 SDK 接入页提供，源文件 web/src/app/sdkMetricQueries.ts：

- 统计 CTE 对源行求 sum(sample_count)、sum(value_sum)、min(value_min)、max(value_max)。平均值为总和/总数，不平均窗口均值。
- 分布 CTE 独立 ARRAY JOIN bucket_values/bucket_counts，合并九个百分位。不能对窗口 P95 再求平均，不能在展开桶后累加原统计。
- 若 sum(distribution_count)<sum(sample_count)，总数/总和/平均仍有效，全体 min/max/P 值为 NULL，并返回 incomplete_distribution。历史没有可信分布的行也保守处理。
- 逐次记录请求时，QPS=sample_count/查询跨度秒数；SQL 以 samples_per_second 命名通用速率。人数累计可用该值，在线人数/跨实例 UV 需要不同语义，不能由观察次数推断。
- P005、P05、P10、P30、P50、P70、P90、P95、P995 分别取 0.005、0.05、0.1、0.3、0.5、0.7、0.9、0.95、0.995。反向排序对应互补分位，无需复制数据。

默认按 metric_name/key1/key2 分组，用户可添加 key3…key16，或按 service/env/版本/实例/槽位过滤。每行覆盖窗口内观察，时间边界按整窗口解释；若需要更细时序，需缩短采集窗口或保存原始事件。

## 系统与历史兼容

新系统日志统一 lightmoni_log，指标统一 lightmoni_metric_sum/gauge/histogram，component=center/agent/sdk。不再为组件各建新物理表。旧视图入口保留，并按 component 联合旧物理历史与统一新表；新目录只展示四张系统表。历史数据不重写，旧物理表原保留周期继续有效。

Agent host/probe/files 使用固定任务表；旧自定义任务配置在读取/执行时规范化，历史业务表继续可查。匿名业务仍仅允许实时启用的豁免名单，且无 SDK 自身遥测。

## 参考

- [OTLP 数据模型](https://opentelemetry.io/docs/specs/otel/metrics/data-model/)
- [OpenTelemetry SDK](https://opentelemetry.io/docs/specs/otel/metrics/sdk/)
- [ClickHouse quantileExactWeighted](https://clickhouse.com/docs/reference/functions/aggregate-functions/quantileExactWeighted)
