# SDD 167 验证记录

## 实测问题分类

逐一展开生产会话的 5 个 `propose_agent_update` 结果，确认不是统一“更新失败”：

- `c7e4dc3f0199077c`、`6b7eb612d973ea1b`：已有待审批、运行中或结果未知的维护，禁止重复创建。
- `f1c08d6da7d729e1`、`5db953cf242e8d80`：使用旧发行摘要，目标发行不可用或摘要已变化。
- `9473f8974462e85d`：存在待执行、运行中或结果未知的任务，必须先处理。

本次不取消、不审批、不升级这些生产主机。指令要求每批刷新发行目录；摘要变化仅刷新重评一次，已有维护/任务不得盲目重试。

## 实现

- `AgentUpdateProgress` 复用 `AgentUpdatePlanSummary` 展示目标主机、当前/目标发行、SHA256、步骤、影响与有效期。
- 仅完整原生 `awaiting_approval` 且无 rollout 的记录显示审批动作；成员、非法/失败结果、已结束或 rollout 记录不显示。
- Apply 前 GET 当前记录，管理员勾选审阅后调用原生 `/apply {confirm:true}`；取消通过 Popconfirm 调用 `/cancel`。
- 接受后展示 running/verifying 和原记录链接，明确不等于升级成功；真实 succeeded/rolled_back/failed/unknown/cancelled 保持各自语义。
- 非完整结果回退到原工具错误展示，避免错误被审批卡片吞掉。

## 验证

- Runtime（Agent 工具、助手、Host/Agent 能力、MCP）：**36/36 通过**。
- 助手记录解析、审批资格、ID 编码路径、过期及时间线：**12/12 通过**。
- SSR：待审批摘要与按钮、running 接受非成功、成员/非法结果无审批动作：**3/3 通过**。
- `npm run typecheck`、`npm run build`：通过。
- `git diff --check`、SDD Markdown 链接和代码围栏检查：通过。

验证不包含生产审批或实际 Agent 升级，不将 SSR 当作真实主机执行证据。没有新通用审批/执行工具，原生 revision、owner、凭据、有效期与任务围栏不变；架构影响不适用，未修改 `docs/system-design.md`。
