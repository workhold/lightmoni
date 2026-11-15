# SDD 176：Agent 维护车道可观测与 unknown 死锁出口

## 背景

生产排障（2026-11-15，zsw-hk8c8g）暴露四类可改进点：

1. unknown 维护记录在主机指纹漂移（如 helper 重生成）后形成死锁：只读核对因指纹不一致返回 `agent_update_recovery_unverified`，恢复又要求先通过核对围栏，取消只接受 `awaiting_approval`，状态恢复仅限卸载后；唯一出路是数据库手术。
2. 中心内层 busy 车道是裸 `Set`，409 只说"有终端、检查或部署正在进行"，看不到持有者、起始时间，也无法在确认中断后释放；一条瞬态循环任务即可让主机长时间不可维护。
3. 维护围栏 409 不可行动：`validateProbe` 把 ready、服务状态、生命周期锁、操作锁四种失败合并成一句话；`maintenanceWorkBusy` 只返回布尔，管理员不知道被哪些任务阻塞。
4. 应用实例恢复投影丢失线索：`reconciliation_resources` 已保存 `job_id/observed_at`，但应用状态投影的 SELECT 不取这两列，管理员看不到是哪个任务占用了机器、状态观测了多久。

SDD 173 已解决 current 损坏时的恢复运行时选择与助手内联核对/恢复审批；本 SDD 不重复其范围。

## 用户场景与验收

### US1：核对后确认维持原程序（keep_current 终结）

- `POST /api/v1/machines/:id/agent-updates/:updateId/reconcile` 新增可选 `resolution: 'keep_current'`，必须携带非空 `reason`（≤500 字符）；仅管理员。
- 终结前必须通过两道安全闸：启动确认窗口已结束（维护器不可能再自行启动）；新鲜只读 probe 证明当前程序不是本次目标发行（版本/构建/摘要任一命中目标即拒绝，改走只读核对提交流程）。在此基础上要求受管安装健康（`validateProbe`，不要求服务在运行）、Agent 身份与平台一致、无生命周期锁与操作锁，且当前服务状态与审批计划中的原程序服务状态完全一致。
- 任一前提不满足即拒绝（新固定错误前缀 `agent_update_keep_current_unverified`），不做任何远端写操作、不改自动核对行为、不放宽既有 `agent_update_recovery_unverified` 围栏。
- 满足前提时将 unknown 终结为 `failed`，receipt 保存 `manual_keep_current`（reason、actor、指纹、服务状态、时间），追加 `keep_current` 阶段事件；`markRecoveryVerification` 不再执行。
- 不提供任何自动/批量/AI 触发路径；AI 工具不新增写能力。

### US2：busy 车道可观测与受控释放

- 内层 busy 由 `Set<string>` 改为 `Map<string,{holder,since}>`，各加锁点记录持有者类别（terminal / ssh-check / installation / deployment / agent-update）与起始时间；语义不变（存在即忙）。
- `GET /api/v1/machines/:id/busy` 返回 `{machine_id,busy,holder?,since?}`；仅管理员。
- `POST /api/v1/machines/:id/busy/release` 需 `{confirm:true, reason}`（非空 ≤500）；无占用时幂等返回 `released:false`；释放仅作用于内存车道并记录结构化审计日志（actor、holder、since、reason），不触碰任何数据库围栏或远端主机。
- `idle()` 的 409 带持有者中文名与起始时间，并提示管理员可通过忙状态接口释放。

### US3：围栏 409 可行动

- `validateProbe` 按失败前提细分固定消息：ready 未通过 / 服务未运行 / 生命周期锁未释放（给出锁文件路径与处置建议）/ 操作锁未释放（说明是残留维护或任务状态文件，建议重启 `lightmoni-agent` 让 Agent 自检回收）。
- `validateOriginalProbe` 的 409 保留固定错误码前缀 `agent_update_recovery_unverified`，追加漂移维度（程序指纹/运行模式/权限代次/执行通道/服务状态）。
- 新增 `maintenanceBlockers` 返回阻塞任务明细（kind/id/state，最多 8 项）；`maintenanceWorkBusy` 布尔语义逐字节不变；Agent 维护的 taskBusy 409 列出阻塞明细，明细为空时保持原文。

### US4：应用恢复投影补全

- 应用状态投影的 recovery SELECT 增加 `job_id`、`observed_at` 两列，实例 `recovery` 字段透出占用机器的任务 ID 与最近观测时间；不改变任何调度或恢复行为。

## 非目标与边界

- 不修改 Web 交互流程（错误消息映射仅补新固定键）；不新增 AI/MCP 写工具；不自动清除 unknown、不自动释放 busy、不放宽任何围栏。
- busy 释放只清内存车道：数据库任务围栏（task_runs/agent_jobs/privileged_jobs/bootstraps）与主机残留锁仍按既有协议处理。
- 不改变维护器、升级、回退、批次和恢复卸载的任何远端行为。

## 成功标准

1. 指纹漂移的 unknown 记录可通过带 `reason` 的 `keep_current` 核对在满足前提时终结；前提不满足时仍被拒绝。
2. busy 车道可查询持有者与起始时间，管理员可凭 confirm+reason 释放；释放前 `idle()` 拒绝、释放后放行。
3. 维护围栏 409 列出阻塞任务明细；probe 失败消息指明具体前提与处置建议；`maintenanceWorkBusy` 语义不变。
4. 应用实例 recovery 投影包含 `job_id` 与 `observed_at`。
5. 类型检查、生产构建、定向 Runtime 回归、版本一致性与 `git diff --check` 通过。
