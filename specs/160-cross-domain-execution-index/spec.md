# 160 · 跨领域执行索引与统一查询

状态：实现与验证完成，等待评审与合并授权。继承 SDD 046/047/134～159 和全平台能力开放 Goal，本切片扩展 Slice 4 的跨领域执行索引。PR #208～#213 和依赖 PR #214 均未获本轮合并授权，本切片 stacked 在 #214 上并独立创建 PR，不自动合并。

## 需求与范围

1. 复用 execution_index 的 domain/native_id/host_id/state 投影，覆盖 Task Run、服务 Deployment、运维 Run、Agent 首装和 Agent 维护，不新增第二套执行状态机。
2. 新增 `lightmoni_domain_executions_list/get`，支持 domain/state 过滤和有界分页；原生记录为事实来源，读取时刷新真实 native_state 与安全 review_url。
3. 各领域同时要求 executions.read 与对应 deployments.read/operations.read/agents.read；Task/Agent 生命周期继续执行 Host 授权，部署/运维保持安装级授权。
4. queued/running/unknown/rolled_back 保留原生语义，不映射为成功；历史未索引记录不保证全部回填。
5. 不开放审批、执行、OpenAPI/Bearer、服务主体或持续授权。

## 非目标

- 不复制领域 SQL、恢复逻辑或执行回执正文，不把索引当成执行队列。
- 不宣称 OpenAPI、普通程序 Bearer 或完整 Slice 4 已完成。

## 验收

1. 各领域执行记录可按 domain:native_id 查询，原生状态变化在读取时刷新。
2. 领域 Scope、Host 授权、domain/state 过滤和分页生效，无敏感回执泄漏。
3. 内部助手、MCP 和会话 HTTP 复用同一查询；官方 MCP 客户端可发现并读取真实 Task Run。
4. 相关回归、类型检查、构建和 runtime 全量与既有基线对比有真实记录。
