# 149 · 服务部署提案与稳定执行授权

状态：已实现，待 PR 审核。继承 SDD 046/047/134～148 和全平台能力开放 Goal，本切片是 Slice 3 的部署计划创建。当前 stacked 基线包含 SDD 138～148；PR #192～#202 未获本轮合并授权，本切片独立创建面向 main 的 PR 并明确依赖，不自动合并。

## 需求与范围

1. 新增 `deployments.propose` 与 `lightmoni_deployments_plan`，为现有 service/target/release 创建原审批计划，不直接执行。
2. 同时要求 deployments.read，确保调用方能读取真实目标/Release；全部 admin、allHosts=true，有限主机授权不开放。
3. 新增 ExecutionGrantRegistry，将外部 deployment 与稳定 grant、owner、原因和来源关联；同 ID 不覆盖授权。
4. 审批事务与中心 SSH 派发前复验 grant、deployments.propose/read；撤销、过期、降权或校验器缺失时不得开始主机执行。
5. 内部 propose_service_deployment 改走 Dispatcher；原部署计划、目标/Release/预检/Agent 围栏、审批和真实回执不变。
6. 不开放回滚、取消、制品上传、遥测核验写操作、审批或直接执行；这些需要独立后续切片。

## 非目标

- 不改变部署状态机、Agent Job、中心 SSH 或制品协议。
- 不提供服务级资源授权或自动批准，不把 agent_ready/queued 当作成功。
- 不宣称回滚、运维、Agent 或其他 Slice 3 提案已完成。

## 验收

1. 外部部署计划只保存 awaiting_approval，审批前无 Job；审批后沿用原 Agent/SSH 执行路径。
2. 同 key 幂等、异输入冲突；无 read/propose、有限 Host 或成员不能调用。
3. 撤销后审批失败；审批后、SSH 派发前撤销会阻止未开始 Job，不影响既有内部计划。
4. 内部工具使用同一 Dispatcher；官方 MCP 客户端完成计划、审批和真实状态读取。
5. 相关回归、类型检查、构建和 runtime 全量与 main 基线对比有真实记录。
