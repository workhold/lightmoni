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

## Workload recovery after Agent reinstallation

workload.inspect.configuration_matches 按 Docker Compose 的真实命名卷身份判断。默认项目范围卷、显式 name、external 卷分别解析；错误前缀、错误来源或读写权限必须为 false，不可为消除误报而省略卷检查。依据 https://docs.docker.com/reference/compose-file/volumes/ 与 https://docs.docker.com/compose/intro/compose-application-model/。

proof.action 可为 restore_binding、retire_absent 或 retire_retained。retire_retained 仅适用于中心期望 removed、无容器且固定目录存在的旧实例；仅退役中心记录、释放端口，receipt.data_retained=true、remote_writes=false，保留原目录与原身份审计。两次只读证据必须相同；运行期望且缺失受管状态继续拒绝。前端完整展示原目录和“退役已移除记录，保留原目录”影响。

POST /api/v1/machines/:id/workload-recoveries/plan(reason) 冻结主机、当前 Agent、全部旧实例、资源修订、端口与期望，生成只读核验任务；GET 同路径 /:operation 返回准备、待审批和最终状态。POST /:operation/apply(revision,confirm) 仅接受已审阅的同一 5 分钟计划，重新只读核验后原子应用；POST /:operation/cancel 只取消未执行计划。所有端点管理员、no-store，任务通过既有签名执行权限与身份门禁。重复 apply 回读原事务，不重复绑定；旧回执不能覆盖新绑定。远端仅固定 Docker ps/inspect 及固定受管目录 lstat/read，摘要不含原始配置、环境、凭据或业务内容。成功只恢复管理绑定与保持数据位置，后续正常控制器验证真实状态。

## Cache policy and catalog host ports

单容器 command=[]、entrypoint=[] 与未提供覆盖等价，继承镜像默认值；非空覆盖严格比较，Compose 显式空列表继续保留。旧 state 的一次正常重新收敛不改变数据位置。

缓存策略比较忽略 JSON 对象字段顺序及未序列化的 undefined，不忽略实际字段、值或额外字段；真实变化继续返回 private_registry_cache_policy_changed。Gitea 新建默认 host_ports.ssh=2222、容器 22，环境 SSH_PORT=2222；显式固定覆盖须同步克隆端口，0 继续拒绝。已有资源和普通集群容量门禁不变。

成功只读 inspect 在 desired_state=removed 且 present=false 或 containers=[] 时保留 removed；停止容器不等于移除。成功 stopped/removed 观测不累加运行健康失败，running 下的缺失与失败/未知回执仍失败。
