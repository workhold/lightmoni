# SDD 166：助手取消状态与 SSH/MCP 实测

## 背景

生产会话中，5 个 `check_managed_machine_ssh` 在约 12 秒后被统一取消，页面却全部显示红色“失败”。事件证明这些结果不是 SSH 连接、认证或权限错误。随后对一台注册主机执行受控的真实只读检查，`connected=true`、`ready=true`，全部依赖与权限检查通过，未创建提案或修改主机。需要修正取消语义，并分别用真实 SSH 与 MCP 客户端验证边界。

## 用户场景与验收

### US1：取消不再冒充失败

当用户停止、浏览器断开或整轮取消时，未完成工具显示“已取消”，只有真实工具错误显示“失败”。

- 后端为取消时补齐的工具回执写入 `status="cancelled"`，保留真实错误说明。
- 前端支持 `running/success/error/cancelled` 工具状态；历史事件中先记录 `error`、后记录整轮取消的工具也归一为已取消。
- 工具标签使用非错误色的“已取消/Cancelled”；`turn.failed` 与真实工具失败保持 `error`；取消只归一运行中或与整轮取消原因相同的历史待完成工具。

### US2：真实只读 SSH 验证

至少对一台注册主机完成 `check_managed_machine_ssh(selection=auto)`，核验真实 `connected/ready/error_code/checks`，不创建安装提案、不更新 Agent、不修改主机。

### US3：真实 MCP 协议验证

使用独立、最小权限、短有效期 PAT，通过 Streamable HTTP MCP 完成初始化、`tools/list` 和只读调用；验证主机范围与撤销边界，不把 HTTP 200 当作业务成功。

- 只授予 `hosts.read` 与 `agents.read`，限定一台主机。
- 调用主机清单和主机级 Agent 升级回执，确认返回结构与授权目标；installation-wide 发行清单不得出现在单主机授权中。
- 对未授权主机读取必须被拒绝；撤销 PAT 后再次调用必须被拒绝。
- 凭据仅存在受保护进程环境，不进入仓库、日志、PR 或文档。

## 功能要求与成功标准

1. 后端取消回执、前端历史归一和标签测试覆盖取消与真实失败两条路径。
2. 相关 Runtime、Web、AI runtime 回归、类型检查与构建通过。
3. 保存真实 SSH 检查结果摘要和 MCP 初始化、工具发现、授权读取、越权拒绝及撤销拒绝证据。
4. 不改变 SSH 固定只读命令、主机权限、MCP 工具名称/Scope、提案审批或部署边界。
5. 不发布镜像、不更新生产主机，不把 fixture 当作真实 SSH/MCP 证据。

## 架构影响

不适用。本次只修正助手事件与展示状态语义，组件职责、数据/控制路径、凭据边界、存储、协议和部署拓扑不变，因此不修改 `docs/system-design.md`。
