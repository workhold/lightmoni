# 实施设计

- `runtime/src/capabilities/`：Principal、能力描述符、Dispatcher、调用审计、幂等和安全领域适配。首期复用 TaskProposalService/TaskRunStore，保留历史 owner 与会话边界。
- `runtime/src/mcp/`：专用授权存储、OAuth资源服务器/授权服务器、官方 SDK Streamable HTTP。部署在原中心进程，共用SQLite；MCP不直连Agent。
- App装配统一对象；内置AI任务工具、HTTP能力接口和MCP经过相同Dispatcher。未迁移的旧工具不对MCP导出。
- Web新增MCP接入管理和OAuth同意页；用户授权后可用环境变量引用PAT，或使用预注册OAuth客户端。
- 先以官方SDK支持的2025协议实现与测试，不宣传未实现的2026适配；工具发现与调用均重验当前授权。
- 真实执行仍由现有任务中心审批/派发/Agent回执证明；本轮不变更Agent控制协议。
