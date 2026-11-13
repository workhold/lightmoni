# 实施计划

## 1. 核心访问边界

- 在能力模块新增 Session/Capability Access，集中处理当前用户刷新和 Web/助手 Principal。
- 通过可选的外部授权适配器委托 MCP Principal 与稳定 grant 校验；未配置时明确拒绝外部主体，不影响会话主体。
- MCP Access 复用会话基础能力，但不再成为 Dispatcher 和通用 HTTP 的唯一访问提供者。

## 2. 应用装配

- 始终创建 CapabilityDispatcher、注册通用能力 HTTP 路由，并把它和共享 TaskProposalService 传给内部助手。
- 仅在外部地址合法时创建 MCP Access、授权管理路由和 MCP Transport。
- 外部地址不合法时保留明确的 MCP 禁用响应和原平台可用性。

## 3. 兼容与失败关闭

- 不改能力名称、Schema、Scope、响应 Envelope 和现有领域 API。
- 保持外部提案 beforeApply、afterApply、领取前授权复验和 unknown 语义。
- 缺少外部适配器时，对 `source=mcp` 返回授权不可用，不创建执行。

## 4. 验证与交付

- 新增无 MCP 的核心单元/HTTP 测试和真实应用装配测试。
- 运行 MCP 能力、接入、OAuth、传输、助手任务及模式基线回归。
- 运行 runtime 全量测试、全仓类型检查和构建；如实记录未执行的真实客户端与生产验证。
- 更新系统设计、平台 MCP 架构和接入说明，提交功能分支并创建面向 main 的 PR，不自动合并。
