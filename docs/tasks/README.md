# 并行任务

这些任务书保留最初的 Go 实现设计和历史验收。2026-10-17 后平台源码与流程以 [Node 迁移规格](../../specs/007-node-runtime-migration/spec.md) 和根 README 为准。

| 任务 | 交付边界 |
| --- | --- |
| [01 大盘](01-dashboards.md) | Grafana 核心操作、AntV 图表、SQL/变量/布局/模板 |
| [02 日志](02-logs.md) | Kibana 探索、分页/实时流、字段/上下文/保存检索 |
| [03 告警](03-alerts.md) | 告警组/目标、规则状态、通道、outbox/历史 |
| [04 SDK](04-sdk.md) | Go/TypeScript、OTLP、聚合/关联/有界重试/demo |
| [05 Agent](05-agent.md) | 本机采集、拨测、持久队列、控制面、安装 |
| [06 主干](06-core.md) | 存储/接入/查询/认证/UI 壳/部署/联调 |
| [07 AI](07-ai-assistant.md) | Doca 会话/SSE/工具骨架、SQL/日志/大盘草稿 |

按并发容量分批执行，先稳定主干契约和采集链路，再联调各界面；模块完成不等于最终验收，所有状态以实际证据记录。
