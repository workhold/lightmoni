# 设计与实施计划

1. 参考 Salt minion 的运行账户配置、systemd User/Group 与 NoNewPrivileges 官方语义；只借鉴模型，不复制外部实现。
2. 使用单一 Agent composition root，root模式内嵌既有签名执行模块；控制/上报与受管执行签名凭据是内部不同用途的凭据，不是两套服务。
3. 配置统一为 runtime_mode（root/user）与 permission_generation；心跳/status报告实际uid/gid及代次。普通任务固定为专用账户，高权限任务仍逐任务绑定账户与批准。
4. 安装默认root并显式审阅；新增可审计的运行模式维护计划，SSH执行固定本地程序，校验可信程序、状态权限、代次和目标；失败恢复旧配置或保留unknown门禁。
5. 平台API、AI/MCP既有下发与审计入口复用；前端收敛为运行模式、能力策略和单一维护入口，不再要求分别维护“执行器”。
6. 分层执行契约/单元/生命周期/权限/界面测试；完成仓库+Doca同步、回读和GitHub PR。

接口共同约定：AgentConfig增加 runtime_mode 和 permission_generation；固定受管执行配置 `/etc/lightmoni-agent/managed.json`、数据 `/var/lib/lightmoni-agent/managed`，不创建独立 executor 服务。Agent CLI提供 managed-enroll（stdin bootstrap）、managed-status；打包固定 `runtime-mode.mjs` 供 SSH 修改运行模式。具体调用契约在实施前各模块协同锁定。
