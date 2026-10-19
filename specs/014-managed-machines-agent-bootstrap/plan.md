# Implementation Plan: 主机管理与 Agent 引导部署

## 设计

1. 新增 `managed_machines`、`machine_credentials`、`machine_deployments` SQLite 表。秘密使用现有应用加密接口保存，密文信封包含 machine/credential 绑定信息；查询接口只返回元数据、指纹、状态和保留策略。
2. 新增 `runtime/src/server/managed-machines.ts`：主机 CRUD、凭据轮换/撤销、部署计划、审批和部署回执。部署 worker 使用凭据 ID 短期租约，私钥通过临时 0600 文件交给系统 `ssh`，主机 key 通过 `ssh-keyscan` 后比对已确认指纹；密码凭据仅登记，不自动执行。
3. 扩展 Agent enrollment store，以内部方式创建短期一次性 enrollment token；固定部署模板只接收 stdin/FD token，复用现有 Agent 安装与激活契约。
4. AI 工具增加 `list_managed_machines`、`get_managed_machine`、`propose_agent_install`、`get_agent_installation`，全部是 read/draft；不增加任意命令工具。系统提示补充 SSH 秘密、主机输出和部署审批边界。
5. Web 新增“主机管理”页面：主机列表、连接凭据状态、主机指纹确认、添加/轮换/撤销凭据、部署计划审阅和脱敏回执。页面显式展示“密码建议只使用一次，不要长期保存”。
6. 连接方式支持 `direct_ssh`、`bastion` 元数据、`manual_script`；本阶段只自动执行已确认 SSH 私钥流程，密码和私网机器提供手动脚本提示。

## 安全与可靠性

- 管理员写权限；成员可见性默认仅管理员，AI 计划也只允许管理员。
- 凭据不进模型、浏览器回显、日志和错误；输出截断并脱敏。
- 主机地址、端口、用户名和版本严格校验；部署单机互斥，15 分钟计划 TTL，30 分钟执行超时。
- 计划和回执记录 actor、machine、credential、版本、digest、阶段、结果，不记录秘密。

## 验证

运行时单元测试覆盖输入校验、加密隔离、密码 TTL、权限、计划审批、主机指纹阻断、AI 工具秘密边界和失败幂等；Web typecheck/build 与受控浏览器验证覆盖提示、创建、撤销和部署计划审阅。
