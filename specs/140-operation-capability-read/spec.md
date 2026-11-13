# 140 · 运维与计划任务只读能力

状态：已实现，待 PR 审核。继承 SDD 046/047/134～139 和全平台能力开放 Goal，本切片是 Slice 2 的运维领域。当前 stacked 基线包含 SDD 138/139；PR #192/#193 未获本轮合并授权，本切片独立创建面向 main 的 PR 并明确依赖，不自动合并。

## 需求与范围

1. 新建 OperationsReadService，复用 OperationsStore 与操作计划模块，统一资源/Run/Schedule 的安全读取、筛选、分页和大小限制。
2. 新增资源 list/get、Run list/get、Schedule list/get 六个只读能力；Schedule 详情包含真实 fires，Run 列表仅安全元数据，Run 详情沿用原模型投影。
3. 新增 `operations.read`，全部只向管理员开放且为安装级权限；有限主机授权不能读取运维资源、Run 或 Schedule。
4. 内部保留 list_operations_resources/get_operations_run，新增资源详情、Run 列表和 Schedule 工具；过滤旧实现，propose_operations_action 仍为内部专用。
5. 网站 static_files、Compose 正文、敏感日志和超大回执继续省略/裁剪；queued/running/unknown、disabled_reason 和原生 fire 状态不得伪造成功。
6. 不开放运维提案、审批、取消、手动触发、Schedule 写操作、任意脚本或 SSH。

## 非目标

- 不改变 OperationsStore、Agent Job、Schedule 状态机或 Web 领域 API。
- 不提供主机级运维资源授权，不读取原始秘密或业务日志。
- 不宣称 Slice 3 运维提案或主机/Agent 领域已完成。

## 验收

1. 六个新能力复用 OperationsReadService；资源安全摘要、Run 元数据/详情和 Schedule fires 有真实测试。
2. 无 operations.read、有限主机或成员不能读取；直接 invoke 不绕过。
3. 内部旧工具输出兼容，新工具无重复；敏感日志和正文不泄露。
4. 官方 MCP 客户端发现/调用六个能力，无 plan/approve/run/delete 工具。
5. 相关回归、类型检查、构建和 runtime 全量与 main 基线对比有真实记录。
