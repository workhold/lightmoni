# 150 · 运维操作提案与执行授权

状态：实现与验证完成，等待评审与合并授权。继承 SDD 046/047/134～149 和全平台能力开放 Goal，本切片是 Slice 3 的既有运维资源操作提案。当前 stacked 基线包含 SDD 138～149；PR #192～#203 未获本轮合并授权，本切片独立创建面向 main 的 PR 并明确依赖，不自动合并。

## 需求与范围

1. 新增 `operations.propose` 与 `lightmoni_operations_plan`，为既有资源调用 OperationsStore.plan 的固定允许操作，不新增任意命令。
2. 同时要求 operations.read；全部 admin、allHosts=true，有限主机和成员不开放。
3. 使用 ExecutionGrantRegistry 以原 ops_runs.id 绑定稳定 grant、owner、来源和原因；审批与中心 privileged 派发前复验 propose/read。
4. 同 key 幂等、异输入冲突；原资源 revision、30 分钟期限、审批、Agent Job 和 unknown 语义不变。
5. 内部 propose_operations_action 改走 Dispatcher，保留原 runMetadata 返回，不暴露额外预览/回执。
6. 不开放资源创建/修改/删除、审批、取消、手动触发、Schedule 写入或直接执行。

## 非目标

- 不改变 OperationsStore 的提案/审批语义、Job、privileged executor 或 Schedule 状态机。
- 不将 read_only 操作变成自动执行，不提供任意脚本/SSH。
- 不宣称回滚、Agent 或其他 Slice 3 提案已完成。

## 验收

1. 外部运维计划只创建 awaiting_approval Run，审批前无 Job；审批后使用原 Job 路径。
2. 同 key 幂等，权限/Host/成员边界生效；撤销后审批和未开始 privileged Job 均 fail closed。
3. 内部旧工具输出兼容且无重复；官方 MCP 客户端完成计划、审批和状态读取。
4. 相关回归、类型检查、构建和 runtime 全量与 main 基线对比有真实记录。
