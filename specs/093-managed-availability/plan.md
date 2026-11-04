# 设计
中心 cluster-workloads 持久保存实例 serving、last_ready_at、failure_since。heartbeat_grace_minutes 默认 5；deployment.min_available_percent 默认 60。已发布实例过期/失败先宽限，再按集群预算撤流，受保护地址不算真实 ready。发现、网站后端、网关 DNS、网站状态共用判断；命令仍只派给当前在线 Agent。
托管升级以真实 ready 数限制 in-place；预算不足和故障迁移先创建 surge，每集群最多一个。当前代际成功 ready 回执后事务退役旧槽位并提升替换，再异步清理旧实例。失败/未知不切换；有状态保留边界。容量不足明确 pending。
Agent apply/inspect 共用 readiness；HTTP 状态码白名单、不跟重定向、超时有界、地址来自本机授权端口。有检查时覆盖 Docker HEALTHCHECK 结论，但常驻容器仍须运行/初始化须成功；未配置维持旧判断。检查间隔进入中心 inspect 调度。
架构影响：存储、控制路径、签名配置。同步 docs/system-design.md 新增 SDD093 章节和 Doca 同名章节，保留原生图块/无关内容并回读。
验证：可控时钟平台集成测试覆盖宽限、持久成员、60%底线、集群隔离、surge失败/成功、升级与未知栅栏；本地 HTTP 响应/超时；runtime/web 类型检查与表单浏览器验证。

提升替换槽位后，普通应用至少排空30秒且全部相关已发布网关确认新bundle才清理；OpenResty入口等待DNS已验证更新后的600秒TTL。retire_after持久保存排空期限，DNS失败不停止旧入口。失败替换仅显式重试或新授权代际重试；unknown沿用检查栅栏。

启动就绪等待与原有Compose启动窗口一致，最多300秒，失败期间不发布替换；每秒重试且响应取消信号。

预算允许原地升级时，先持久设draining并撤出成员；等待相关网关确认撤流配置及排空期限后再派发Docker更新。draining期间普通inspect/网站重载不得提前覆盖状态或触发更新；中心重启后继续等待。
