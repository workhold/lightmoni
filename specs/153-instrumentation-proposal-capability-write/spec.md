# 153 · SDK 插桩提案与执行授权

状态：实现与验证完成，等待评审与合并授权。继承 SDD 046/047/134～152 和全平台能力开放 Goal，本切片开放 Slice 3 的中心受限工作区 SDK 插桩提案。PR #192～#207 已合入；本切片从最新 main 独立开发并创建新 PR，不自动合并。

## 需求与范围

1. 新增 `code.workspace.propose` 与 `lightmoni_code_instrumentation_plan`，复用 InstrumentationService 的真实扫描、base_revision、结构化 Diff、加密 before 快照和 awaiting_approval 计划。
2. 同时要求 code.workspace.detail.read；仅管理员、allHosts=true，成员和有限主机授权不开放。
3. 外部来源保存 owner、来源、稳定 grant 和原因；加密计划、capability_idempotency 与 ExecutionGrantRegistry 在同一 SQLite 接受事务中保存，同 key 幂等、异输入冲突。
4. 原生管理员 Apply 在 revision 和文件写入前复验外部稳定 grant、双 Scope 和安装级权限；缺失绑定、撤销、过期或降权时 fail closed。
5. 新增受保护的原生计划审阅 GET，复用 read 安全投影，不暴露 before 快照。MCP 创建/回放只返回有界 Diff 摘要和 review_url，内部助手保持原完整计划结构。
6. 内部 propose_sdk_instrumentation 改走 Dispatcher，不写外部 grant，不重复注册。
7. 不开放 Apply/审批工具、code_task、任意路径、任意命令、项目代码执行或直接文件写入。

## 非目标

- 不改变插桩 Diff 生成、revision、Apply 原子写/失败恢复和加密存储状态机。
- 不把计划创建或 Apply 接受表述为代码已修改/遥测已验证。
- 不宣称 Agent 升级/恢复/卸载、服务回滚、告警值班提案或真实客户端矩阵已完成。

## 验收

1. 外部计划只保存 awaiting_approval，文件不变；同 key 并发/串行幂等，异输入冲突。
2. read/propose Scope、管理员、安装级授权生效；撤销和无绑定外部计划不能 Apply，文件不变。
3. MCP 响应不含 before 或超限 Diff，管理员可通过受保护 review_url 读取完整计划；内部旧工具输出兼容且无重复。
4. 官方 MCP 客户端完成扫描、计划、原人工 Apply 边界和状态读取。
5. 相关回归、类型检查、构建和 runtime 全量与既有基线对比有真实记录。
