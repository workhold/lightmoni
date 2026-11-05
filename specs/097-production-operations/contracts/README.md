# Contracts

## Maintenance
当前 machine/agent 绑定取得持久维护预约后，后台 inspect 不能再次抢占。只有未领取、attempts=0、无lease，且私有加密载荷证明为 node/workload/gateway.inspect 的受管读取可延后（含用户主动 inspect）；保留任务和回执。用户脚本、部署/卸载等写操作、运行中执行和未经核对 unknown 仍阻塞。规划预约最多120秒，正常完成/失败按token释放，随后由既有待审批维护记录接管；不手工改数据库状态。

## Telemetry identity
标准资源 host.name 表示可读机器名，service.name 表示服务名；host.id、lightmoni.machine_id、lightmoni.agent_id 保留稳定归属。认证 heartbeat 返回的 machine_name 用于后续批次，缺失时 hostname 降级；已入持久队列 payload 和去重身份保持不变。中心根据经验证的 deployment/application/machine 关系补受管观测名称，伪造 deployment 仍拒绝。SDK 现有名称环境注入与 service 配置兼容，不把 ID 字段改成名称。

## Evidence
仅 zz-bj-1 操作，记录受测版本、时间、实际回执与恢复；卸载保留业务数据。告警本地触发/恢复可验证，未经明确收件方授权不发外部消息。未完成项注明原因。
