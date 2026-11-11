# SSH 主动运维契约

- 凭据创建：机器页面只提交 `retention: "permanent"`，不提交 `expires_in_seconds`；API 省略 retention 等价 permanent，旧客户端显式有限期策略继续可用。响应保留 `retention: "permanent"`、`expires_at: ""`，不含秘密。
- 凭据迁移：仅活动且秘密尚在的有限记录改为永久；已过期、已撤销、已清除记录原样保留。迁移事件可审计。
- SSH 作业：原 `agent_jobs`、`privileged_jobs` 和手动 `task_runs` 是持久执行记录；中心在派发时选择主机默认 SSH 账户及有效绑定，握手核对固定主机公钥。每台主机只启动一个固定发行包命令：`managed-once`、`jobs-once` 或 `task-once`，命令行仅包含精确作业 ID 和固定配置路径，不含秘密或领域载荷。
- 远端单次进程按精确 ID 通过原签名执行器接口或 Agent 作业接口领取冻结领域计划，并经原通道传输制品、密钥和回执。常驻进程的无 ID 领取被中心拒绝；定时任务仍由 helper 无 ID 领取。中心 SSH 凭据不下发。目标必须可以出站访问中心。
- SSH 派发失败且作业尚未领取时记录明确失败码；已领取时沿原租约变为 `unknown`，核对只读且不重跑原动作。原作业身份和历史保留。远端旧发行包须升级后方可执行新 SSH 单次命令。
