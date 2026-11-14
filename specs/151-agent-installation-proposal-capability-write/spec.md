# 151 · Agent 安装提案与执行授权

状态：实现与验证完成，等待评审与合并授权。继承 SDD 046/047/134～150 和全平台能力开放 Goal，本切片开放 Slice 3 的既有 Agent 首装计划。当前 stacked 基线包含 SDD 138～150；PR #192～#204 未获本轮合并授权，本切片独立创建面向 main 的 PR 并明确依赖，不自动合并。

## 需求与范围

1. 新增 `agents.maintain.propose` 与 `lightmoni_agent_installations_plan`，输入既有主机、fresh check_id、固定版本、匹配架构、可选初始标签和 runtime_mode。
2. 同时要求 agents.read；仅管理员。主机范围凭据只能为已授权 machine_id 提案，成员不开放。
3. 复用 ManagedMachineStore.assistantPlan/createPlan，保存原生 awaiting_approval 安装计划、target_revision、预检证据和真实 review_url；不连接 SSH、不签发 enrollment、不创建执行。
4. 使用 ExecutionGrantRegistry 以 machine_deployments.id 绑定稳定 grant、owner、来源和原因；计划与幂等同事务保存。
5. 原生管理员 Apply 在过期/revision/凭据检查及任何安装写动作前复验 propose/read 和 machine_id 主机授权；撤销、过期、降权或主机范围缩小后不得开始安装。
6. 内部 propose_agent_install 改走 Dispatcher，保持原计划返回结构且不写外部 grant。
7. 不开放 SSH 预检、直接安装、审批、取消、恢复、升级、回滚或卸载工具。

## 非目标

- 不改变 Agent 首装、enrollment、runtime/helper、SSH 执行、恢复或 unknown 状态机。
- 不允许模型提供任意命令、下载 URL、凭据正文、架构或未经预检的目标。
- 不宣称 Agent 升级/恢复/卸载、服务回滚、插桩写入或真实客户端矩阵已完成。

## 验收

1. 外部计划只创建 awaiting_approval 记录，同 key 幂等、异输入冲突，返回真实原生审阅地址。
2. read/propose Scope、管理员和主机授权在发现、调用、审批时生效；越权不能创建或开始计划。
3. 撤销后 Apply 返回 authorization_revoked，不签发 enrollment、不执行 SSH；内部/既有无绑定计划保持兼容。
4. 内部旧工具输出兼容且无重复；官方 MCP 客户端完成计划、原生审批边界和状态读取。
5. 相关回归、类型检查、构建和 runtime 全量与既有基线对比有真实记录。
