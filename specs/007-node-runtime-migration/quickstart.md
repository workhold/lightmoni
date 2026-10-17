# Validation guide

使用独立数据库副本与端口验证新中心和 Agent。禁止两个调度器同时连接同一生产库。测试 fixtures 使用伪密钥和受控 ClickHouse/模型/通知服务。

预期命令：`npm --prefix runtime ci`、`npm --prefix runtime run typecheck`、`npm --prefix runtime test`、`npm --prefix runtime run build`。中心和 Agent 分别使用构建后的 server/main.js、agent/main.js，环境变量及 CLI 保持原名。

每项旧公开路由、密码/密文样例、OTLP 两编码、精确数值、批次重试、旧队列重启、目录轮转、任务撤除、告警接手/outbox、助手取消/账本均在 coverage.md 中对应测试。浏览器验收使用既有隔离脚本针对新中心静态资产，真实数据保留快照。

最终检查及复跑命令见 [validation.md](validation.md)；原存储副本证据见 [old-data-validation.md](old-data-validation.md)。
