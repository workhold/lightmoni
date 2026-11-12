# 单次入口能力与准入契约

- 普通 Agent 心跳可包含 `ssh_once_commands: ["jobs-once"]`；签名 helper 心跳可包含 `ssh_once_commands: ["managed-once", "task-once"]`。集合无重复、无未知值，中心从当前绑定身份的认证心跳读取。旧客户端可不发送，缺失时不推断支持。
- 迁移例外：缺少新字段时，完整 `source_revision=16b151337cc94c1b7f3f7de56bdcad561759c85b` 且 `release.state_schema=1` 的既有已验证发行支持三个入口。显式声明始终优先于迁移例外；其他旧版没有声明时均视为不支持。
- 所有特权作业（受管运维、容器、提权脚本）都由 `managed-once` 执行，因此该入口决定三种能力是否为 `ready`；`task-once` 只决定任务中心的手动及人工重试脚本可否新排队；`jobs-once` 决定普通主动 Agent 作业可否新排队。只有 `task-once` 的 helper 不放行提权脚本。定时任务保持 helper 原领取通道。
- 无能力证据时创建接口返回 409 与稳定升级原因；已排队但未领取的记录由中心扫描写入 `agent_upgrade_required`。已领取和 unknown 记录不受该失败处理覆盖。
- 执行时继续校验 SSH 默认账户、凭据、主机指纹、Agent/执行器身份和原签名授权；能力证据不携带秘密，也不授权任意 SSH 命令。
