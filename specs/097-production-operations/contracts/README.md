# Contracts

## Maintenance
当前 machine/agent 绑定取得持久维护预约后，后台 inspect 不能再次抢占。只有未领取、attempts=0、无lease，且私有加密载荷证明为 node/workload/gateway.inspect 的受管读取可延后（含用户主动 inspect）；保留任务和回执。用户脚本、部署/卸载等写操作、运行中执行和未经核对 unknown 仍阻塞。规划预约最多120秒，正常完成/失败按token释放，随后由既有待审批维护记录接管；不手工改数据库状态。

## Telemetry identity
标准资源 host.name 表示可读机器名，service.name 表示服务名；host.id、lightmoni.machine_id、lightmoni.agent_id 保留稳定归属。认证 heartbeat 返回的 machine_name 用于后续批次，缺失时 hostname 降级；已入持久队列 payload 和去重身份保持不变。中心根据经验证的 deployment/application/machine 关系补受管观测名称，伪造 deployment 仍拒绝。SDK 现有名称环境注入与 service 配置兼容，不把 ID 字段改成名称。

## Evidence
仅 zz-bj-1 操作，记录受测版本、时间、实际回执与恢复；卸载保留业务数据。告警本地触发/恢复可验证，未经明确收件方授权不发外部消息。未完成项注明原因。

## Builtin observations and dashboards
中心 heartbeat/运行事件投影也应携带当前受信机器名。内置 Agent/SDK 曲线和日志、通用主机模板以机器名/服务名为主要可读来源，内部绑定仍用稳定ID。已有系统大盘只对仍精确匹配旧配方的查询作有版本记录的更新；用户编辑、布局、设置及已删除大盘保留，不在每次启动强制覆盖。端点发现问题必须保留 HTTPS、中心身份和凭据 audience 校验。

## Legacy installation preflight
旧 root 常驻 Agent 与旧 user unit 按仓库固定 SHA 识别，升级只读探测返回409及旧版卸载/重新接入指引，不授予新权限或自动迁移。其他无法验证的安装也返回明确的受管安装检查错误；仅返回固定诊断码，不回传远端正文。识别失败不生成待审批更新记录。
