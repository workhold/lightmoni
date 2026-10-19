# SDK 通用打点与统一遥测表

## 最终用户要求（2026-10-19，优先于早期讨论）
1. SDK 业务初始化必填 service、env；可选 service_version、instance_id。endpoint/密钥可使用环境配置，不要求每次初始化填写 table、metric_name、类型、单位或聚合配置。
2. 业务 API：record(table, metric_name, {key1:字符串,...,keyN:字符串}, value, count)。同一客户端可写多个表/指标。用户只在请求后记录耗时或值，无需注册 instrument 或理解聚合。
3. 同一 SDK 状态按 table、metric_name、规范化维度值聚合；service/env 在实例内固定，不参与本地分组键，但仍随资源上传供中心隔离。维度使用固定槽，首版 key1…key16，未提供为无此维度；不因 isp/province/country/asn 新建列。
4. 每 10 秒自动轮换 Delta 窗口并批量发送；本地保持 count/sum/min/max 与可合并分布。退出 shutdown 发送剩余窗口。有限内存、维度上限、非有限值校验、重试保留原批次和窗口，不静默吞错。
5. 中心可查询所有窗口/实例合并后的 sum/count/min/max/加权 avg，以及 P0.5/P5/P10/P30/P50/P70/P90/P95/P99.5；P005 表示 P0.5。反向 P99.5/P95/P90/P70/P50 分别使用正向 P0.5/P5/P10/P30/P50。不可平均窗口/实例分位数。
6. 每次数据库请求耗时 record 一次，count 为调用数，QPS=count/查询时间跨度；value_sum 是总耗时，不能当作访问次数。所有分位数为分布近似，精度需可观察，不承诺精确原始分位数。
7. 所有有效且启用密钥可写任意业务表；只按名称创建密钥，不再按表授权。缺失 Authorization 仅可写实时启用豁免表，错误/空凭证不降级。匿名 SDK 不上报自身事件/指标。
8. 系统日志统一 lightmoni_log，指标按数据类型使用 lightmoni_metric_sum/gauge/histogram，component=center/agent/sdk 区分；Agent 任务 host/probe/files 固定，不允许自定义任务目标表。历史数据与旧查询继续可用。
9. SDK 接入保留 SDK 样例、SDK 密钥、豁免表三个 Tab，仅展示 Go/Node/Rust/Python。Demo 不选表；展示统一 record 调用与可复制 SQL。豁免名单不需要初始化或每次手工选择。

## 验收
四语言新 API 实际执行：仅初始化service/env，自动实例标识，可覆盖版本/实例；多表多指标与维度值分组；大量调用压缩为每组每窗口一条；定时自动 flush，shutdown flush；乱序 keys 相同分组、缺失槽规范、非法槽拒绝。
中心在真实 ClickHouse 上验证字段、跨实例/窗口统计、count QPS、9种正向和反向分位数、正负/零/长尾分布误差、丢 ACK 冻结重试及去重。任何网页演示都不能向运行实例写测试数据。

## count 补充（最终用户要求）
record(table,metric_name,dimensions,value,count)。count 为必填正整数，value 是这 count 个样本的总和，不是每个样本的值；餐厅value=100/count=5得总额100、人数5、avg20。count=1产生完整分布，count>1只产生sum/count汇总，不臆造个体min/max或分位数。混合查询发现分布覆盖不足时返回不完整标识，默认min/max/P值为空；sum/count/avg仍有效。
