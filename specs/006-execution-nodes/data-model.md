# Data model

## Entities and storage

| 对象 | 存储 | 主要字段与关系 |
|---|---|---|
| 执行节点 | `agents` | 原有身份、心跳及兼容 `group_id`；中心标签由关联表保存 |
| 任务标签 | `agent_task_labels` | `id`、唯一 `name`、`created_at`；API 附加节点及任务引用数量 |
| 独立任务 | `agent_tasks` | `id`、`name`、`type`、`enabled`、类型内配置 JSON、`created_at` |
| 任务目标 | `agent_task_targets` | `task_id/label_id` 复合主键；删除任务同时移除目标 |
| 节点标签 | `agent_node_labels` | `agent_id/label_id` 复合主键；删除节点同时移除关联 |
| 迁移版本 | `agent_task_migrations` | 记录 `independent-tasks-v1` 已完成，重启不重建旧任务 |

## Invariants

- 标签名称去首尾空格后非空、唯一，名称最多 128 字节；任务名称同样有长度限制。每节点及任务最多关联 64 个标签。
- 任务类型是 `host/probe/log`，仅保存本类型的采集参数；`enabled` 独立于配置，停用保留配置。
- 任务与节点标签 ANY 匹配并按任务 ID 去重；空集合不匹配任何任务。
- 默认标签保留；有节点或任务引用的标签删除返回 409。
- 合成配置保持 32 进程名称、32 日志源和 128 拨测限制，同类型冲突及合并超限整体返回 409。
- 任务、目标、节点标签及兼容数据的变更在一个 SQLite 事务中完成，先验证实际节点合成配置，再提交。

## State changes and compatibility

新建/更新任务、启停任务、删除任务和改派节点标签均触发有效配置重新计算。配置内容、任务及标签元数据参与稳定 revision；心跳中的已应用 revision 与中心 revision 可比较。

旧分组迁移为同 ID 标签和 `legacy:{labelID}:{host|probe|log}` 三类任务，保留其启用状态和参数。旧节点只绑定原标签；重新注册不覆盖中心分配。原 `group_id` 保留给旧协议，不作为新多标签权威。没有匹配任务时显式关闭内部指标及目录采集并清空拨测，业务 OTLP 转发独立继续。
