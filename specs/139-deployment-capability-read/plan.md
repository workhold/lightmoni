# 实施计划

## 1. Store 安全视图

- 扩展 ServiceDeploymentStore：assistantServiceDetails 返回 service/targets/releases；assistantDeployments 返回该服务最多 100 条真实部署。
- 两个方法直接复用路由使用的 service/targets/releases/deployments 闭包，不新增 SQL 或投影分支。

## 2. 能力描述符

- services.list：原服务列表。
- services.get：服务详情、目标与 Release。
- deployments.list：service_id + limit/offset，返回分页原生部署。
- deployments.get/events：准确 deployment_id 的真实状态和时间线。
- 全部 deployments.read、admin、allHosts=true；详情/部署内容为 R1，服务目录 R0。

## 3. 内部助手与 MCP

- Dispatcher 添加三个旧名称和两个新读取名称适配器。
- registerAssistant 在共享 Dispatcher 存在时过滤三个旧实现，保留 propose_service_deployment 内部提案。
- MCP 接入页增加 deployments.read 中英文标签，官方 SDK 验证发现和权限。

## 4. 验证与交付

- 添加 Store/能力/权限/状态/内部适配器和 MCP 测试。
- 复跑部署、核心、描述符、遥测、告警、日志/Trace 和授权回归。
- 执行全仓类型检查、构建和 runtime 全量；main 既有失败单独对照。
- 更新系统设计、平台 MCP 和接入指南，推送 stacked 分支并创建面向 main 的 PR，注明依赖 #192，不合并。
