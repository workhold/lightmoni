# 实施计划

## 1. 主机安全读取

- 保留 hosts_list/get 原逻辑。
- 新增 hosts.inventory/details，使用 ManagedMachineStore.assistantList/assistantGet 和 Dispatcher host 授权。
- 内部 list_managed_machines 保持 `{machines}`，get_managed_machine 解包详细 machine。

## 2. Agent 读取

- agents.releases.list 使用 agentUpdates.listReleases。
- agents.installations.get 使用 machines.assistantDeployment，并按结果 machine_id 复验 Host。
- agents.updates.get 使用 agentUpdates.assistantGet(machine_id,update_id)。
- Release 为 allHosts=true；安装/维护为 Host 资源授权；全部 admin 和 agents.read。

## 3. 内部助手与装配

- Dispatcher 添加五个旧名称适配器；无对应 Store 时不注册新能力。
- monitoringTools 在共享 Dispatcher 下过滤旧主机/Agent 读取，仅保留远程预检和内部提案。
- 应用注入 managedMachines，MCP 接入页增加 agents.read 标签。

## 4. 验证与交付

- 添加主机/Agent、资源授权、秘密、内部助手和官方 MCP 客户端测试。
- 复跑主机/Agent 安装维护、核心、描述符和其他领域回归。
- 执行全仓类型检查、构建和 runtime 全量；main 既有失败单独对照。
- 更新系统设计、平台 MCP 和接入指南，推送 stacked 分支并创建面向 main 的 PR，注明依赖 #192/#193/#194，不合并。
