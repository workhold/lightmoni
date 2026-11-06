# 中心内部运行指标交付修复

线上中心启动日志可查，但 heartbeat/heap 与在线中心指标为空。RuntimeMonitor 已显式设置内存 exporter 进入 Ingest.internal，SDK 却仅因未设置 HTTP Key 将系统批次静默出队。修改前本地复现 delivered=0、pending=0；新增 SDK 回归先失败，修复后实际交付两个指标/日志批次。

门禁仅对默认 HTTP 传输生效，显式回调不需要 HTTP Key。默认匿名 HTTP 系统批次继续抑制，匿名自身诊断继续关闭；上报禁用、取消及重试正文冻结与网络接收认证不变。未增加网络入口、凭据、权限或表；本地 docs/system-design.md 已同步。按用户本轮要求不再同步 Doca。

验证：SDK全套27项通过；runtime类型检查/编译通过；RuntimeMonitor、durable ingest、SDK传输模式、下载范围共5项通过。RuntimeMonitor集成实际产生新鲜心跳、堆、队列、事件循环、请求计数和直方图，日志敏感词脱敏。固定镜像与线上连续数据仍待T019，不能把隔离内存sink或空SQL成功当作ClickHouse新鲜数据。

PR108已按追加授权合入main；下一固定发行包含手动原机对账/保留解析、托管最低预算与副本保障。发布验收仍区分合成DNS/Agent回执与实际生产行为。

同步合入PR108后的main，组合相关回归82项全部通过、0跳过，覆盖托管副本保障、手动原机修复/保留DNS、网关失败最后发布证据及内部遥测。
