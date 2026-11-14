# 141 · 主机与 Agent 只读能力

状态：已实现，待 PR 审核。继承 SDD 046/047/134～140 和全平台能力开放 Goal，本切片是 Slice 2 的主机/Agent 领域。当前 stacked 基线包含 SDD 138～140；PR #192/#193/#194 未获本轮合并授权，本切片独立创建面向 main 的 PR 并明确依赖，不自动合并。

## 需求与范围

1. 保留现有 `lightmoni_hosts_list/get` 的投影和响应；新增 hosts inventory/details 以复用 ManagedMachineStore 的 assistantSafe 安全视图。
2. 新增 `agents.read`，提供 Agent Release 列表、安装结果和维护/升级/回退结果读取；复用 ManagedMachineStore 与 AgentUpdateStore 的 sanitized receipt。
3. 内部保留 list_managed_machines/get_managed_machine/list_agent_releases/get_agent_update/get_agent_installation，全部通过 Dispatcher；过滤旧读取实现，保留内部安装/升级提案和远程预检。
4. 主机详细读取继续支持 host_ids 资源授权；Agent 安装/维护结果按 machine_id 复验，Release 目录为安装级权限。无 Scope、越权主机或成员不能读取。
5. 不返回 SSH 密码/私钥、Host Key、enrollment/control/data 凭据、下载票据或原始命令输出；unknown/rolled_back 不得报告成功。
6. 不开放 SSH 预检、安装/升级/回退提案、审批、取消、卸载或任意生命周期执行。

## 非目标

- 不改变 Agent 安装、维护、rollback 和回执状态机。
- 不把现有 hosts 工具改为包含 SSH 账号元数据的新响应。
- 不宣称卸载、恢复、文件/容器或终端能力已经开放。

## 验收

1. 新主机详细目录/详情与 Agent 三类读取来自真实领域 Store，旧 hosts 工具兼容。
2. host_ids 对详细主机/安装/维护读取生效；Release 为安装级，成员和越权直接调用被拒绝。
3. 内部五个旧工具名和输出形态保持，无重复注册；无外部提案/执行工具新增。
4. 官方 MCP 客户端可发现和调用五个新能力；秘密和原始输出不泄露。
5. 相关回归、类型检查、构建和 runtime 全量与 main 基线对比有真实记录。
