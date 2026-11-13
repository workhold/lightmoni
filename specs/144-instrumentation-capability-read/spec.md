# 144 · SDK 插桩只读能力

状态：已实现，待 PR 审核。继承 SDD 046/047/134～142 和全平台能力开放 Goal，本切片是 Slice 2 的受限工作区/SDK 插桩领域。当前 stacked 基线包含 SDD 138～142；PR #192～#197 未获本轮合并授权，本切片独立创建面向 main 的 PR 并明确依赖，不自动合并。

## 需求与范围

1. 新增 `code.workspace.read` 与 `code.workspace.detail.read`，分别控制只读扫描和完整插桩提案/Diff 读取。
2. 新增 instrumentation scan/get，复用 InstrumentationService 的 canonical workspace、安全排除、扫描和 owner/权限边界；只允许明确配置的中心工作区。
3. 内部保留 scan_sdk_instrumentation，新增 get_sdk_instrumentation；过滤旧扫描实现，propose_sdk_instrumentation 与 Apply 仍保持原内部路径。
4. 应用装配共享同一个 InstrumentationService 给 Dispatcher 和 Assistant，提案加密存储与原 revision/审批语义不变。
5. 扫描不执行项目代码、不跟随 symlink、不读取秘密文件；提案读取不返回加密 before 快照或无关存储内容。
6. 不开放 code_task、代码任务结果、插桩生成/应用、任意文件读取、提交、推送、PR 或部署。

## 非目标

- 不把用户本地源码当作远端 MCP 可读资源；只读管理员配置的中心 workspace。
- 不改变插桩计划、Diff、Apply 或代码任务状态机。
- 不宣称代码任务持久异步化或通用源码能力已完成。

## 验收

1. 扫描与提案读取使用真实 InstrumentationService；workspace 越界/秘密文件/代码执行有原领域防护。
2. 普通 Scope 不能读完整提案，详情 Scope 独立；有限主机和成员被拒绝。
3. 内部旧扫描和新读取通过 Dispatcher，共享服务不重复，原 propose/Apply 回归不变。
4. 官方 MCP 客户端可扫描并读取既有提案，无 generate/apply/code_task 工具。
5. 相关回归、类型检查、构建和 runtime 全量与 main 基线对比有真实记录。
