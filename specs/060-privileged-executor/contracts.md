# 目标契约与首批实现

本文件保留完整目标契约；首批实际实现受系统设计60.10与任务清单约束，不能将未迁移适配器视为已可用。提权脚本当前只允许立即一次性root账户执行，容器只支持最小无挂载/端口的结构化操作，执行器生命周期按completion.md统一收口，业务profile范围保持分期。

首批固定入口为 `privileged-executor/main.js enroll|run|check|status --config /etc/lightmoni-executor/config.json`；`enroll`仅从受保护stdin读取预绑定bootstrap，`status`为只读，返回 `executor_id/machine_id/install_generation/policy_generation/fenced/pending_results`，其中pending_results是未确认回执数量，安全卸载要求fenced为null且数量为0。

主机UI使用 `POST /api/v1/machines/:id/executor-bootstrap/plan`、`POST .../executor-bootstrap/plans/:planId/apply` 与对应GET列表/详情；apply明确confirm、expected_revision与稳定request_id，秘密不进入响应。未知安装的reconcile仅在同一远端flock内证明固定安装路径和服务缺席后结束原记录，不能重放安装。独立维护通过 `executor-maintenance/plan`，action为upgrade/rollback/repair/uninstall；apply同样审批快照，cancel仅未开始，reconcile仅unknown且只读。核对时可显式选择新的有效credential_id，不能修改原审批秘密快照或重放卸载。

字段和端点名称为本 SDD 的实现约束；实现前必须以严格 schema 落入 shared 协议并新增协议版本。未知字段拒绝，不将下列示意作为现有 API。

## 发行与运行角色

一个发行包包含固定 agent 与 privileged_executor 入口，共用协议与执行组件。ExecutionContext的principal/身份提供器/策略/目录由对应组合根固定注入；普通角色常驻run/轮询/采集实际UID为0时，在创建Agent/runner前拒绝，version/check/configure等固定离线安装管理命令不受此限制；特权角色实际UID非0或缺root私有身份/策略时拒绝。role不提供提权，不能由任务载荷修改。代码及路径祖先root所有；两角色可独立激活兼容版本，凭据、journal、锁和防重状态不共享。各自unit单独定义写目录/沙箱/子进程策略，不能只改User复用普通Agent unit。

公共journal在root通道的强制契约：写入/fsync失败拒绝副作用、损坏拒绝执行、unknown回报失败保留记录/fence。每角色独立current/previous/fingerprint与兼容性；共享物理发行时GC/卸载同时检查两角色引用及在途/unknown。

## 主机权限与计划

- SSH 预检：`privilege.state=root|sudo_noninteractive|unavailable|unknown`，包含 `checked_at/expires_at/machine_revision/credential_binding_revision/endpoint_fingerprint`。失败码为 `privilege_unavailable_or_interactive` 或 `privilege_probe_failed`；不能未取证就断言密码错误。
- 主机能力：`capability=container.managed.v1|script.elevated.v1`，独立 `requested/authorized`、单调 `policy_generation` 与 `effective=disabled|pending|ready|unavailable|blocked|disabling|unknown`，附执行器最后签名观察时间；过期观察不能是 ready。
- `POST /api/v1/machines/:id/execution-policy/plan` 冻结当前绑定、能力、路径/daemon 观察、策略代次和安装文件摘要；首次安装/修复还需有效 SSH 引导预检，已有可信执行器可通过固定策略管理动作应用已批准的新策略，不需 SSH 凭据或重新 enrollment。`.../plans/:planId/apply` 仅管理员确认精确未过期计划。关闭在中心先撤权再发受控清理，未确认显示 disabling/unknown；pending 仅用于启用待应用。
- `GET /api/v1/machines/:id/execution-status` 只返回状态、版本、profile、观察时间和安全错误码，不返回密钥、原始 inspect、环境或脚本秘密。

## 任务与执行主体

- Agent job 增加 `task_run_id/execution_principal/executor_id/install_generation/policy_generation`。`execution_principal=agent` 与 `privileged_executor` 的 claim/payload/artifact/events/result 完全隔离；所有接口的中心校验均不可仅依赖自报 capability。
- `task.script` 只在普通 Agent 运行；`task.script.elevated.v1` 是新类型，不能给旧任务偷偷补 `run_as=root`。
- 提权脚本计划包含脚本原始 UTF-8 字节 SHA-256、大小、解释器固定 ID 与运行时摘要、参数、cwd profile、环境值/秘密版本摘要、固定主机集合、预检得到的 UID/GID/补充组摘要、超时/输出上限及单次授权；批准后不可修改。
- 首期提权脚本仅立即单次执行，拒绝 at/interval/cron 和自动重试，无“所有将来版本”或标签新成员授权。批量批准枚举每台主机，每主机独立 grant；重试产生新的尝试和审阅，unknown 先核对。
- 提权 grant 硬性存在且不可复制，中心事务 `reserved(run_id) → consumed` 绑定确切 snapshot，executor 启动前持久消费；消费后失败/超时/unknown 不因新 nonce 自动再执行。enqueue、claim、start 和 renew 都重查 grant，不沿用普通任务无授权记录时的默认许可。

## 独立执行器协议

`/api/v1/privileged-executors/:id/` 的 heartbeat、jobs/claim、jobs/:jobId/payload、artifacts/:artifactId、events、result、start-permits、renew、reconcile 为独立 audience。每次请求由 executor key 签名 method、固定规范 path、body SHA-256、request_id、中心实例、executor/install_generation、iat/exp。时钟偏差上限 60 秒；签名有效窗口最多 60 秒；request_id 中心持久去重并校验请求摘要，相同请求返回原结果，不发新租约。

中心的计划和 start permit 使用固定 Ed25519 JWS（protected header 固定 typ/alg/kid，base64url 原始 payload 字节；无动态算法、无远端 jwk/URL）。验签后严格解析，无重复字段、有限大小、固定 v1 schema。payload 包含：

`center_instance_id, machine_id, agent_id, executor_id, install_generation, job_id, task_run_id, operation_id, lease_id, policy_generation, authorization_id/revision, capability, action, resource_id/revision, request_sha256, artifact_sha256/size, executor_nonce, iat, nbf, exp, max_runtime_ms`。

start permit 另含 `step_id/permit_id`，最长 30 秒，绑定 executor 为该步生成且持久化的 nonce，只兑换一次；开始前在线检查授权/绑定/租约。租约默认 45 秒、每 15 秒续租；每个新副作用步骤另取许可。撤权存在已签许可最多 30 秒的启动窗口，不能承诺离线即时撤权。副作用已经开始则按执行 journal 和只读核对恢复。

请求签名的 60 秒时钟容忍不适用于 permit。executor 在该 nonce 的在线请求发出前，按包含系统挂起时间的 Linux 单调时钟设置最长 30 秒 deadline；响应只能缩短剩余期限，不能重新计时。超时响应、时间不可靠、重启/新 boot 均废弃未消费许可；不能凭慢钟/回拨延长启动期限。租约与本地运行截止也使用同类单调计时。

回执由独立 executor key 签名，元数据只包含有序事件、任务/操作/资源摘要、策略代次、journal 状态与白名单现场观察，不携带任意 Docker inspect。脚本 stdout/stderr、容器日志为可能含未知秘密的独立敏感正文，合计每运行最多 256 KiB、加密保存；仅显式授权管理员可读取，不进普通日志/遥测/AI/MCP响应。已知秘密尽力脱敏，不宣称任意输出无秘密。旧代次/迟到结果不覆盖当前配置或 unknown；显式 reconcile 才能解决 unknown。

## root 本地状态

- root:root 程序/配置/信任策略，密钥与状态目录 0700、秘密文件 0600；本地最高策略代次和已消费 permit/nonce 必须持久化。
- 相同 job + request digest 返回现有 journal；相同 job 不同 digest 拒绝。外部副作用无 exactly-once 承诺；执行中重启进入 unknown，不能因 PID 消失自动重跑。
- 持久 fence 按 machine/lifecycle/资源冲突域协调两类执行主体；普通 Agent 自报“空闲”不能解除 root 锁。提权脚本首期独占整机写 fence；普通脚本不构成可信沙箱，不能保证其外部副作用遵守锁。
- 程序回退不恢复旧 journal/fence、防重、完成运行、已消费 grant、身份/密钥撤销水位或策略最高代次；状态丢失/旧备份恢复需新 fencing 代次及现场核对，不能自动初始化继续写。
- 实现错误码至少含 `principal_mismatch, stale_install_generation, policy_disabled, stale_policy, invalid_signature, expired_permit, replay_conflict, dependency_unavailable, unsafe_container_spec, account_changed, privileged_script_not_authorized, execution_unknown`。

## #64 收口：中心边界与生命周期

普通Agent固定只读 capability/action 配对由中心统一校验，拒绝写任务返回409 privileged_executor_required。未迁移业务写入口在创建前返回409 privileged_profile_not_implemented。旧operations私有正文与release artifact下载固定410 legacy_agent_payload_removed，不解密；旧Docker jobs接口410。旧queued写任务cancelled，曾领取写任务unknown，审计code legacy_agent_write_removed，不转root、不重放。

唯一维护接口：GET /machines/:id/executor-maintenance/releases返回{releases:AgentRelease[]}；GET .../probe?credential_id=...只读返回schema=1、完整身份与策略代次、current/previous构建、fenced、pending_results、service_active、repairable与phase。POST .../plan接受action、可选credential_id与仅upgrade使用的target_sha256。current/target包含version、build_id、source_revision、artifact_sha256、state_schema=1、arch；可信本机元数据另含fingerprint。upgrade固定catalog完整SHA，rollback只选previous，repair只选原current与证明阶段；apply/history/cancel/reconcile沿用原路径与幂等形状。

维护计划冻结上述现场、主机revision、凭据revision、executor/install_generation、policy_generation与steps，apply复验并持互斥。固定root监督器stop后取得writer锁、只读核验clean状态并切换；start前释放writer锁。程序回退不动身份、输出密钥、journal、防重、授权、清单、fence与最高策略代次。repair要求active中心身份、完整相同config/key/journal和有效root阶段记录；不支持猜测兼容、重新注册或重建状态。持久started回执和之后exact签名heartbeat共同证明成功，失确认unknown，reconcile只读。


启动确认契约：安装root阶段记录维护activation_id。首次安装生成UUID并在各阶段保持；每次维护在start前持久写本次operation_id。worker启动一次性读取并验证root记录、身份与release，将activation_id纳入独立签名heartbeat必填字段，中心严格解析且保存至executor投影。维护完成要求started receipt.activation_id与heartbeat.activation_id均精确等于维护计划id，并匹配executor/安装代次/程序指纹。旧进程不能在每次heartbeat重读activation而伪装新启动；不兼容缺activation的旧执行器协议。


显式只读核对允许两种持久中断证据：stop未完成且source/current/原activation/active服务与clean journal均精确匹配时，本维护记failed，供新审批repair；ready阶段/target/本operation activation与独立签名heartbeat精确匹配时，即使最后receipt仍switching/unknown，也可保留原始receipt并记录read_only_activation确认成功。自动刷新仍只接受正常started receipt，不通过读操作重放写或删除root执行fence。
