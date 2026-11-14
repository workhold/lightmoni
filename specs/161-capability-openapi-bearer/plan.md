# 实施计划

1. 新增 Capability HTTP 主体解析：Authorization 存在时委托 McpAccess.authenticate，否则使用 Web Session Principal；未配置外部接入时 Bearer 失败关闭。
2. 从 Dispatcher 当前主体可见描述符生成 OpenAPI 3.1 路径、请求/响应 Schema、错误与安全元数据，服务器 URL 使用配置 externalURL。
3. 保持原注册和调用路径兼容，app 注入可选 McpAccess，所有发现/调用继续经过 Dispatcher。
4. 添加 PAT 发现/调用/审计、无效/缺失外部授权、Web 兼容和 OpenAPI 内容测试。
5. 更新系统设计、平台 MCP、接入文档与覆盖矩阵，运行全量回归、类型检查和构建，创建面向 main 且注明依赖 #215 的 PR，不合并。
