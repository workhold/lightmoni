# 契约
- 应用 heartbeat_grace_minutes: 整数1..60，默认5。
- deployments[].min_available_percent: 整数0..100，默认60。
- health 保留 type=http|tcp、port_name、path、interval_seconds；新增 expected_statuses（1..20个不同整数200..599，默认[200]）及 timeout_seconds（1..30，默认3）。path 单斜线起始，不含反斜线、控制字符、fragment。
- 签名 workload.apply/inspect 的 health 含上述配置和派生 host/port，不允许任意目标。
- 实例新增 availability=ready|grace|protected|unavailable、serving；healthy 不把 protected 当健康。集群含 minimum_available、ready_instances、serving_instances。
- pending=minimum_availability_protected / replacement_capacity_unavailable / replacement_pending。
- 显式停止/移除/缩容不受自动撤流预算约束；未知结果沿用执行栅栏。

- 原地更新新增实例state=draining；retire_after在非退役实例上表示更新前排空期限；pending=traffic_drain_pending。

- 健康检查作业要求 operations.platform.readiness.v1 能力，旧Agent不能领取；中心与Agent需一起升级，防止旧Agent忽略状态码/超时仍报告ready。
