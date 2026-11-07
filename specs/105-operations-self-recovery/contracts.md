# 契约

沿用 `website.remove` / `website.inspect`、storage.v2、逐网站逐机器持久删除授权以及 `deployment.instance` reconciliation.v1；无新增写接口和权限。

- 网站 targets 增加 `failures`、`retry_at`、`blocked_agent_version`；`blocked` 是诚实的未完成状态。`error` 仅稳定非秘密原因码；`done` 仅来自本网站本机成功 absent 回执。
- 完全空的非符号链接网关目录不拥有任何网站引用，清理与核对可只读跳过；非空未归属目录、异常布局和目标目录归属仍拒绝。
- 对已登记、同机旧绑定/退役的 OpenResty，中心派发 `legacy_gateways:[{instance_id,application_id,historical_only,site_proofs:[{digest,fragment_id,target}]}]`，摘要只来自既有不可变授权 gateway.apply 载荷。领取时重新核对同一范围，旧未知执行阻断。Agent 要求 layout1 身份、已停止容器的平台/实例标签及精确只读挂载来源证明；通过词法结构和健康证明识别目标 server/独有 upstream 等定义，仅删除目标片段文件与配置，保留其他网站字节。任何缺失证明、活动/外部容器、异常路径或 include 均拒绝。inspect 先确认无历史残留；回执记录已清理旧实例 ID。当前 layout2 实例的 historical_only 范围仅允许清理非 current 的旧历史版本，必须先验证 layout2 owner 与当前索引；不能用于无标记根归属判断。不补 owner、不做通用迁移、不删除旧容器。
- 自动恢复仅消费实例当前 run、期望 hash/代次一致的终态回执；等待同机锁不得丢失 proof。接收结果未知时仍阻断变更。
- 同机忙等待不改变公平排队优先级，其他结果沿既有退避和周期；已知连续失败预算持久化，不因中心重启清零。
- Web 状态字段只投影固定恢复阶段、稳定原因和下次重试时间，不返回原始配置、命令、文件正文或秘密。
- 兼容：当前数据结构仅扩展 JSON 字段；需要统一 Agent 发行升级后执行清理修复。旧 Agent 不被强行绕过能力或归属校验。
