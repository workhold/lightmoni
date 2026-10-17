# Data model and migration

中心保留原 `lightmoni.db` 表、JSON body、revision、外键和迁移标记，具体 schema 从旧模块建表语句逐项迁移。`master.key`、账户 bcrypt、session token hash、供应商加密配置格式保持。价格账本的原单价、终态和未知字段不可重算。

节点保留 identity.json、queue.sqlite（批次/receipt/隔离/日志checkpoint）、remote-config.json、SDK 配置缓存。已冻结正文及 batch ID 不改写；纳秒时间、偏移和 source_seq 使用精确表示。若需要扩展字段，只做兼容添加并有幂等版本标记。

节点/任务/标签 ANY 匹配和三类编译约束保持。会话和告警 JSON 为公共持久契约，不因语言切换重命名字段。每个写操作维持原事务边界。
