# 数据模型

无迁移。复用 machine_deployments.status/error/receipt_json，以及现有 enrollment、runtime、heartbeat 和执行通道在线状态。等待进度不另建存储，旧请求仍通过 status/resolved_at 条件更新防止覆盖人工恢复。
