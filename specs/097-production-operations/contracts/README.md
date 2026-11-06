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

## Endpoint recovery
对已记录中心，先无凭据核对center_id，再认证读取并验证完整清单；成功后解除该source过去的传输冷却，允许后续原有队列重试。没有新验证时仍遵守冷却；401/403、不同中心或无效清单不解除。一次request最多发送一次业务正文，发现恢复不自动重放POST。

## Agent state correction

`GET /api/v1/machines/:id/state-recoveries` 返回管理员可见的恢复历史。`POST .../plan` 接受 credential_id、reason，仅通过固定 SSH 只读脚本核验已移除的 Agent；返回五分钟计划及影响清单，不执行卸载。`POST .../:recoveryId/apply` 要求 confirm=true、confirm_name=已审阅主机名称；再次核验远端、凭据及清单后原子结束旧身份。`POST .../:recoveryId/cancel` 仅取消尚未执行计划。所有接口 requireAdmin；GET 及重复 apply 返回持久回执，不重放远端动作。计划待审阅时阻止新派发，但不会因旧任务 unknown 而无法创建恢复计划。活动工作进程、远端程序仍在、路径不安全、身份/版本变化均拒绝。配置与业务数据全部保留；不能宣称旧业务任务成功。

## Ordinary task capability drop

只信任内核 cap_last_cap 的规范非负整数（0..63）。降权命令同时清除 0 至该上界的 bounding/inheritable/ambient 能力，保留专用 UID/GID、空附加组及 no-new-privs；实际核验五种能力集合均为零。缺失、格式错误或超界均失败，不能通过默认值、截断或保留能力继续。SSH 只返回固定 ordinary_task_identity_check_failed 诊断，不返回远端原文。

## Internal exporter

显式配置 exporter 的 SDK 必须把冻结后的系统表批次交给该回调，无需额外 HTTP Key；此回调不授予中心网络接口权限。未配置 exporter 的默认 HTTP 通道缺少 Key 时继续抑制系统表发送。匿名 collectSelf 仍不产出诊断；全局禁用、取消、持久批次 ID/正文重试及服务端认证不变。中心内存导出集成与发行验收需查到当前实例的新鲜 heartbeat/heap 指标。
