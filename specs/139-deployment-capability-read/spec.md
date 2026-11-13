# 139 · 服务与部署只读能力

状态：已实现，待 PR 审核。继承 SDD 046/047/134～138 和全平台能力开放 Goal，本切片是 Slice 2 的服务/部署领域。当前 stacked 基线包含 SDD 138；PR #192 未获本轮合并授权，本切片独立创建面向 main 的 PR 并明确依赖，不自动合并。

## 需求与范围

1. 复用 ServiceDeploymentStore 的真实服务、目标、Release、部署和事件视图，不复制状态机或直接读取 Agent Job。
2. 新增 `deployments.read`，提供 services list/details、deployments list/get/events；服务详情包含真实 targets/releases，部署历史有界分页。
3. 内部保留 list_services/get_service_deployment/get_service_deployment_events，新增 list_service_details/list_service_deployments；全部通过 Dispatcher，过滤旧实现避免重复。
4. 部署读取只向管理员开放且为安装级权限；有限主机授权不能通过服务详情或部署 ID 读取其他主机目标。
5. 部署 draft/queued/running/unknown 等原生状态和事件如实返回；telemetry stale、error_code、审批和执行 ID 不改写为成功。
6. 不开放部署/回滚提案、审批、制品上传、遥测核验写操作或 Agent/SSH 执行。

## 非目标

- 不改变服务部署状态机、Release 制品边界或 Web 领域 API。
- 不实现服务级 OAuth 资源授权；当前仅管理员安装级读取。
- 不宣称 Slice 3 部署提案或运维/主机领域已开放。

## 验收

1. 服务列表、服务详情 targets/releases、部署分页/详情/事件均来自 ServiceDeploymentStore 既有安全视图。
2. 无 deployments.read 或有限主机授权不能发现/直接调用；成员不获得该管理员领域。
3. 内部旧工具输出保持原形态，新工具无重复；部署状态和事件不被简化成虚假成功。
4. 官方 MCP 客户端可发现和调用五个新能力，无 approve/rollback/upload 工具。
5. 相关回归、类型检查、构建和 runtime 全量与 main 基线对比有真实记录。
