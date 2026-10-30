# 实施任务

- [x] 基于最新主干创建功能分支，完成SDD范围与边界。
- [x] 统一能力层、首批工具、通用提案/幂等/审计及内置AI复用。
- [x] 专用PAT、OAuth PKCE、撤销与用户管理API。
- [x] 官方SDK MCP传输、限制及集成测试。
- [x] MCP管理与授权同意界面、中英支持。
- [x] 回归测试、独立审查、仓库/Doca同步与回读，证据见 [验证记录](validation.md) 和 [Doca 同步记录](doca-sync.json)。
- [x] 提交分支并创建面向 main 的 [GitHub PR #23](https://github.com/workhold/lightmoni/pull/23)。

## 后续验收

- [ ] 真实 Codex/Claude 客户端 OAuth 浏览器授权、刷新与撤销互操作矩阵。本轮自动 HTTP 测试已覆盖服务端流程，PAT 客户端联通已实测，不代替此项。
- [ ] Codex 自然语言完整回合：本次模型服务网络重置/超时；App Server 的 MCP 发现和工具调用已单独验证。
