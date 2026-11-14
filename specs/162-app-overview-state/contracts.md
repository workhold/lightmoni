# 应用总览与状态展示契约

## `GET /api/v1/ops/overview`

- 保留现有管理员鉴权、`cluster_id` 过滤、资源排序以及 `resources`、`agents`、`machines`、`runs`、`capabilities`、`total`、`limit` 字段。
- 每次请求读取一次资源集合；同一 `publicKinds` 与集群过滤结果产生 `total` 和 `resources`。`resources` 最多前 1000 条，`limit` 仍为 1000；每条资源继续走现有公开投影及应用升级信息计算。
- 不增加查询参数、数据库表、顶层响应字段、共享缓存或跨请求快照。`resources[].status.instances[]` 可增加 `unresolved_run_id`；旧客户端调用和权限结果不变。

## 实例未知执行证据与写入门禁

- 实例公开摘要的可选 `unresolved_run_id: string` 仅在该实例 `current_run_id` 指向仍未完成现有人工核对的 `unknown` 运行记录时出现；来源是既有执行/作业记录，不保存新状态，不返回载荷或秘密。即使实例因只读日志作业保持 `state=running`、`healthy=true`，此字段仍表明当前执行结果未知。已完成既有人工核对或当前运行不再 unknown 时不提供该字段。
- `GET /ops/resources/:id` 与总览资源投影均可读到此可选字段。`GET /ops/runs?resource_id=:id` 沿用既有最近 100 条历史记录和权限；“核对状态”只读打开既有安装记录抽屉，优先定位当前未核对的 unknown 记录。若摘要给出的 `unresolved_run_id` 不在列表，抽屉按既有 `GET /ops/runs/:id` 读取原记录并加入可选历史；仅有 `recovery=blocked/unknown_execution_result` 而无当前运行 ID 时，抽屉显示 `unverified` 并优先选择该应用历史中的 unknown 原记录。有当前未核对记录时，已核对的旧 unknown 不抢占默认选择，用户手选记录后自动轮询不抢回，不派发新 `inspect`。按 ID 读取沿用原管理员鉴权与单条运行记录响应，不扩展历史列表或增加新接口。
- 用户发起的应用 `deploy|stop|remove|reconcile` 若目标相关的非退休实例存在未核对当前 unknown 执行，在更改部署 `desired_revision`、`enabled` 或实例 `desired_state` 前返回 `409`，保持原部署意图和实例期望状态；现有主机作业围栏继续生效。管理员按原流程核对后可重试，历史 unknown 回执不被重写；服务自动恢复沿用原路径。

## 页面读取调度

- 首次和显式读取各拥有独立的请求代次。10 秒自动轮询、证书申请中的 2 秒轮询与窗口焦点刷新若发现总览读取仍在进行，则跳过本次触发；旧响应完成后仍可更新页面。
- 手动刷新及会触发新读取的主机/页面范围变化可以取消旧请求并立即开始新读取；本地状态、搜索等筛选不发总览请求。取消的响应和错误不覆盖新请求；取消不显示失败。页面卸载后不更新状态。
- 成功响应解除首屏加载，失败显示既有错误并解除加载；自动刷新不得因为响应慢于轮询间隔而令首屏永久等待。

## 应用展示态

`resourceState(application)` 使用资源 `spec`、`status` 与可选 `unresolved_run_id`，新增仅在前端使用的 `unverified`（中文“待核实”、英文“Unverified”）。已发布范围仅含 `status.deployments` 中 `enabled=true`、`desired_revision>0` 的集群；只看这些集群的非退休当前实例。禁用集群遗留实例不参与成功、失败或未知判定。按下列顺序处理：

| 既有证据 | 展示态 | 操作 |
| --- | --- | --- |
| 启用集群当前实例 `state=unknown` 或有 `unresolved_run_id` | `unknown`／结果未知 | 查原执行记录，即使仍有运行健康摘要 |
| 启用集群明确 `last_error` 或当前实例 `failed|error` | `failed`／失败 | 沿用失败诊断；不被保护态遮盖 |
| 当前实例 `availability=retained|grace|protected`，或 `recovery.state=blocked` 且原因 `unknown_execution_result` | `unverified`／待核实 | 未知执行阻塞时进入应用原执行记录 |
| 各启用目标的 `applied_revision=desired_revision`，当前实例数与 `ready_instances` 均达到目标数，且目标实例均有既有成功健康证据 | `running`／运行中 | 沿用正常管理动作 |
| 全零副本目标无运行实例，或原已停止/未部署 | 原 `stopped`、`configured` 等 | 沿用原动作 |
| 新部署尚未取得实例或仍在排队/执行 | `pending`／待处理 | 沿用部署进度与记录 |

目标数由现有部署配置的托管副本数或手动机器数确定，运行中不能只依据 `applied_revision` 或 `current.every(healthy)`；1/2 就绪仍不成立；零副本目标可无实例或仅有已停/已移除实例；全零目标显示已停止，混合就绪目标仍可运行。2→1 缩容要求目标槽位就绪、额外未退休实例已停/已移除。已退休旧实例不计入当前状态或本轮新增应用动作门禁；未退休但已移除的实例若仍关联 `unresolved_run_id`，仍触发写操作门禁。登记删除另受既有 `store.remove` 对未核对历史运行的独立保护，包括已退休实例的历史。没有启用的已发布集群，但禁用集群留有非退休活动实例或实例摘要截断时，保守显示 `unverified`；只有非退休实例均已停/已移除且摘要完整时才显示 `stopped`。资源 `revision` 高于已发布 `desired_revision` 时，卡片/详情另标“已保存未发布”及已发布版本，不把旧版本健康说成新配置已应用；若现有字段不能证明旧版本的目标数，保守地不标运行中。

卡片、详情和状态筛选使用同一投影。`unverified` 独立于 `pending` 和 `failed`，既有“待处理”筛选必须显式排除 `unverified`；“全部状态”包含全部应用，筛选数量等于可见卡片数。状态标签只看启用已发布集群；卡片动作另扫描所有非退休实例。任一 `state=unknown`、`unresolved_run_id` 或 `recovery=blocked/unknown_execution_result` 均阻止部署/重新部署、停止、卸载、升级和删除登记；其他 `unverified` 阻止升级、停止、卸载及删除登记。凡显示“核对状态”，均只打开既有 `ApplicationInstallDrawer`：读取 `GET /ops/resources/:id` 与 `GET /ops/runs?resource_id=:id`，列表缺失当前 `unresolved_run_id` 时补读 `GET /ops/runs/:id`，优先显示当前未核对的 unknown 运行记录，已核对旧 unknown 不抢占默认选择，手选记录不被轮询抢占，不发新 `inspect`。抽屉在 `unknown|unverified` 时禁用编辑、重新部署和快速安装重试。任何入口都不能自动重试、改写历史 `unknown`、解除主机写入围栏或宣称现场已恢复。

## 兼容性

后端仅在实例公开摘要增加可选 `unresolved_run_id`；执行回执、Agent 协议、数据库记录及旧 Web 客户端调用保持兼容。`unverified` 是显示值，不写回 `status.state`；旧资源缺少完整的就绪/可用性证据时保守展示，不推断为运行中。后端 `applied_revision` 对空实例集合可能因 `every()` 为真而误报，修正其计算不在本轮；前端须用现有目标数、当前实例数及 `ready_instances` 防止展示为运行中。任何真实生产未知结果仍需管理员依现有受管执行核对流程处理。
