# 契约

SDK协商：GET /v1/sdk-config?metric_windows=1，在原revision/log_sampling/disable_rules响应增加metric_windows: Record<逻辑表, Array<{seconds:number,effective_at:number}>>，effective_at为UTC epoch秒，候选10,30,60,300,600,1800,3600，缺省[{seconds:30,effective_at:0}]。数组表示按effective_at递增的单周期生效历史；任一观察只使用不晚于调用时刻的最新一项seconds。同表所有指标与实例遵循相同配置，不同表独立选择。所有字段先验证再原子替换；匿名仅豁免表。Rust补齐该窗口配置轮询入口。

管理：GET /api/v1/metric-windows/:table返回default_seconds=30、periods=[10,30,60,300,600,1800,3600]、history；PUT {window_seconds:number}为该表选择一个周期，需要admin、合法业务表、枚举周期，返回相同结构。window_seconds仅接受七档整数标量；数组或枚举外值返回400。管理界面单选标签为10秒、30秒、1分钟、5分钟、10分钟、30分钟、1小时。变更最早now+60s且对齐lcm(old,new)，同一生效点新配置覆盖未生效项。

查询对齐：查询步长必须大于0，且为范围内所有已知window_seconds的整数倍；范围边界对齐这些周期。30秒上报时60秒、300秒步长有效，10秒无效；配置切换历史按所选数据实际周期的公倍数校验。

重复保存当前待生效周期保留原生效时间；选择回当前生效周期撤销待生效修改，不新增历史。管理界面区分当前与待生效周期，保存失败保留所选值，加载失败允许重试。

新点：attributes包含lightmoni.window_seconds整数，startTimeUnixNano是精确UTC边界；start<=time<=start+period。center从start解析window_start，received_at保持实际接收时间。普通旧点window_seconds=0。新增compact列positive_offset/positive_counts/negative_offset/negative_counts/zero_count，scale保留sketch_scale；新exp行bucket_values/bucket_counts为空，视图即时推导，合计槽<=1024。

distribution是具名Tuple(values Array(Float64),counts Array(UInt64),total UInt64,known UInt64,low Nullable(Float64),high Nullable(Float64),error Nullable(Float64))。pXX助手一个参数，展开后对total/known完整性检查并约束真实极值；metric_min/max同样检查。短名是逻辑表、无重复持久化。
