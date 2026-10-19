# 实现设计

分支 codex/sdk-onboarding，沿用 TypeScript runtime、ClickHouse、四原生 SDK 与现有 OTLP/Agent 队列。

## 自动分布

新增统一五参数 record(table,metric_name,dimensions,value,count)，count 必填正整数；旧指标 API 保留兼容。count=1 使用 OTLP ExponentialHistogram DELTA：默认 scale=8，每侧跨度最多1024桶，必要时按二进制索引降采样；保留 count/sum/min/max/zeroCount。中心转换桶代表值与频次，并暴露随 scale 变化的相对误差界。

count>1 只知道样本总数与总和，使用 OTLP Summary(count,sum,空quantileValues)；不得制造个体分布。每本地组每窗口最多一条指数分布点、一条汇总点；同名不同类型分 Instrumentation Scope。

四 SDK 默认10秒收集；状态按table/metric_name/排序后非空key槽分组，最多2000活跃组，总内存受现有bufferBytes限制。新增桶计入容量，冻结后沿用不可变批次、重试与幂等队列。业务后台收集独立于 SDK 自身遥测；匿名没有自身遥测。

## 中心与 CK

指数分布与 Summary 归入现有 histogram 族。新增 bucket_values、distribution_count/kind、sketch_scale、quantile_error；增加固定 env/service_version/key1…key16 实体列，公开视图增加 metric_name、sample_count/value_sum/value_min/value_max 别名。老表增加 DEFAULT 列并重建视图，不改写历史数据。

SQL 先通过 FINAL 视图去重，统计与桶分布各自 CTE 聚合后合并，防止 ARRAY JOIN 重复累计。avg=sum(value_sum)/sum(sample_count)，速率=count/查询跨度。仅分布覆盖完整时展示全体min/max/P值，否则NULL与incomplete_distribution。分位数使用 quantilesExactWeighted 合并压缩代表值；对原始观察近似。暂不添加未去重输入的增量物化视图。

系统逻辑表统一 lightmoni，公开查询名 lightmoni_log/lightmoni_metric_sum/gauge/histogram。旧查询入口联合原物理历史与新统一表按component筛选；新目录只展示四张系统表，不为兼容入口创建物理表。保留旧物理表及其保留周期。Agent host/probe/files 固定任务目标，旧自定义任务配置规范化。

密钥按名称创建，所有启用密钥可上报任意业务表。无 Authorization 只允许实时启用豁免表；错误/空凭证不降级。历史密钥摘要、状态、审计数据保留。

## 界面与交付

SDK 接入保持三 Tab、四语言。样例增加 env 与可选 service_version/instance_id，删除目标表选择，代码定义未自动执行的 record 业务函数，目标表由用户在代码中替换。提供完整统计/九种百分位 SQL，明确 count 汇总数据的分布限制。

验证四原生 SDK 的密钥/匿名共八路径、分位数误差、自动上报、多窗口/实例、可选身份、丢ACK重试去重、旧物理表迁移与两次重启、三次浏览器与动效验收。构建 SDK/Agent 包，备份后更新唯一18380实例，验证管理员与持久状态。同步远端main再提交功能分支，按PR流程合入。
