# 设计

复用现有OTLP指标/持久队列，不更换协议。新record点带lightmoni.window_seconds，startTimeUnixNano固定为窗口起点，timeUnixNano取实际封窗/提前flush时间。SDK组键加入周期与起点；后台收集不清除活跃窗口内存。新旧配置按时间选择，当前周期切换不按进程启动时间计算。

新增SQLite metric_window_config历史。GET/PUT /api/v1/metric-windows/:table，SDK通过/v1/sdk-config?metric_windows=1获取授权表配置；旧URL响应保持不变。每表配置一个window_seconds标量，默认30秒，候选固定为10/30/60/300/600/1800/3600秒；不同表独立配置，同表所有指标与实例共享配置。管理入口使用单选控件，展示10秒、30秒、1分钟、5分钟、10分钟、30分钟、1小时。history按effective_at记录历次单周期配置，SDK取不晚于观察时刻的最新一项。候选值升序中任一较大值均可被所有前序值整除。中心接收有界迟到旧快照，只对合法配置过的周期接受，不因配置切换重写历史。

保存时在SQLite事务内读取当前与待生效配置；重复保存待生效值保持原生效时间，选回当前值撤销待生效项。管理界面展示当前与待生效周期，保存失败保留输入，加载失败可重试。配置与SDK测试使用固定时刻及本地HTTP接收器验证，查询测试通过Executor检查最终SQL参数与实际窗口对齐。

业务仍只有_lm_metric_<table>_histogram一份物理数据；短名视图<table>查询FINAL，含value=sum及distribution Tuple（values/counts/total/known/min/max/error）。新compact列和窗口列ALTER追加，旧桶DEFAULT兼容；历史原样保留。用稳定OTLP资源/属性/窗口标识合并同请求的exp+summary，禁止跨批次盲目合并。

查询在语法树中替换白名单聚合助手，沿用SQL权限检查。周期校验读取所选视图范围内实际window_seconds集合，检查range边界对齐且interval为这些周期的正整数倍；跨配置变更历史取公倍数，查询宏时间也按window_start。30秒上报可按60秒或300秒查询，不可按10秒查询。无固定窗口旧行不猜测。中心配置可选操作置于既有表管理，不增加SDK接入Tab。
