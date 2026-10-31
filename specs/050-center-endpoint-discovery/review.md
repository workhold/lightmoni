# SDD 050 差异审查

- 发现契约独立于严格校验的 SDK 配置接口，旧中心可继续接受显式 endpoint；旧地址缺少 scope 时按 public 迁移。
- 选择器先核对候选身份，再发送原 SDK/Agent 凭据；刷新已发现地址前重新核对身份。限时、响应大小、禁止跳转与标准 TLS 校验覆盖引导和探测流程。身份标识只用于误配防护。
- 所有 Agent 中心请求共用选择器，job/task 客户端通过同一 fetch 适配器处理；当前没有绕过选择器的独立中心 WebSocket。业务 HTTP 写入不在同次调用内切换入口，已有批次去重边界保留。
- SDK 自定义进程内 exporter 保持原路径，独立 Agent 继续使用自身队列；公开 SDK 接收/配置代理及相关死代码删除。
- 接入页、SDK 示例、历史兼容语言默认值、验收脚本、AI 工具 schema 和生成代码一致为中心直连。历史 SDD 保留并标注由 050 替代。
- 跨语言只读研究与审查已完成，随后运行原生 SDK 套件及完整 Runtime 回归；未留下已知阻塞问题。证据与明确限制见 validation.md。
- `.specify/extensions.yml` 不存在，无 before/after implement 扩展钩子需要执行。
