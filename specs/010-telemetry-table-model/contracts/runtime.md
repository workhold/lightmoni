# SDK 与存储契约

## 初始化与唯一打点入口

- Go：`Init(service, env)`；可选配置用 `New(Config{Service, Env, ServiceVersion, InstanceID, ...})`。
- Node：`createLightMoni({service, env, service_version?, instance_id?})`。
- Python：`Client(service=..., env=..., service_version=..., instance_id=...)`，后两项可省略。
- Rust：`Client::init(Options::new(service, env))`，可在 Options 设置 service_version/instance_id。

endpoint/key 可从 LIGHTMONI_ENDPOINT/LIGHTMONI_KEY 读取。业务初始化不绑定表。新接口要求非空 service/env；版本与实例标识可选，实例标识缺省自动生成。资源使用 service.name、deployment.environment.name、service.version、service.instance.id。旧构造与指标 API 保留兼容。

唯一新打点入口为 `record(table, metric_name, dimensions, value, count)`（Go 使用 Record），五个参数均必填。dimensions 仅允许 key1…key16，值为字符串；省略与空串都表示无该维度。count 为正整数，逐次观察传 1；value 是这 count 个样本的总和。不得提供默认 count 或另设 record_count 方法。

## OTLP 与本地聚合

仍 POST /v1/metrics。按 table/metric_name/规范化维度分组，默认 10 秒收集；每组每窗口最多一条 ExponentialHistogram（count=1 的观察）和一条 Summary（count>1 的汇总）。同名不同类型使用不同 Instrumentation Scope。冻结后的批次、窗口与标识不随重试改变。

ExponentialHistogram 为 DELTA，包含 count、sum、min、max、scale、zeroCount、positive/negative(offset,bucketCounts)、startTimeUnixNano/timeUnixNano 及固定槽属性。中心校验 scale -10…20、每侧桶长不超过 1024、桶计数和等于 count、有限数值、min<=max、合法时序及现有批次大小/时间窗口。

Summary 只允许正 count、有限 sum、空 quantileValues。count>1 不把 value/count 伪造成个体样本。SDK 不生成该部分的 min/max/分位数。

## ClickHouse 查询列

业务记录视图 `metric_<table>_histogram`，统一系统分布视图 `lightmoni_metric_histogram`；底层 ReplacingMergeTree，公开视图 FINAL 去重。每行是一个实例、一个窗口、一个维度组合的聚合点，不是逐条观察。

固定实体列：service、env、service_version、instance_id、metric_name、key1…key16。固定统计列：sample_count（count）、value_sum（sum）、value_min/value_max（可空）、bucket_values(Array(Float64))、bucket_counts(Array(UInt64))、distribution_count、distribution_kind、sketch_scale、quantile_error。保留旧 name/count/sum/min/max 与原始资源/属性兼容。

Summary 行 distribution_count=0、min/max=NULL、桶为空；完整指数分布行 distribution_count=count。汇总使用 sum(value_sum)/sum(sample_count)，仅当 sum(distribution_count)=sum(sample_count) 时返回全体 min/max/P 值，否则返回 NULL 与 incomplete_distribution。

分位数在独立 CTE ARRAY JOIN 桶，用 quantilesExactWeighted(0.005,0.05,0.1,0.3,0.5,0.7,0.9,0.95,0.995)(代表值,频次) 合并；原窗口统计在另一个 CTE 计算，防止 ARRAY JOIN 重复累计。P005=P0.5%，P995=P99.5%。反向 P99.5/P95/P90/P70/P50 对应正向 P0.5/P5/P10/P30/P50。查询完整窗口，不按边界比例伪造窗口内分布。

## 权限与系统表

密钥 POST 只需要 {name}；旧 scope 字段经类型校验后忽略，输出 allowed_tables=[]/allow_all_tables=true。有效启用 key 可写所有业务表；缺失 Authorization 只允许实时启用的豁免表；错误或空凭证不降级。

匿名 SDK 不上报自身遥测；SDK 系统上报需有效 key 且命中已有事件/指标白名单。系统逻辑表 lightmoni，查询名 lightmoni_log、lightmoni_metric_sum/gauge/histogram，component 区分 center/agent/sdk。兼容旧查询入口，旧物理历史不删除；内部 component 由可信通道确定。
