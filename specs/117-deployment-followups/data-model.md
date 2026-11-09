# Data model

- 主机容量：heartbeat.cpu_count正整数逻辑核、memory_total_mb正有限MiB、observed_at；旧缺失unknown。
- 文件条目：name/type/size/mode/modified_at/version；写入expected_version、confirmed；rename不覆盖。
- 批量容器：完整id/name/revision、有界批次、逐项verified/error/unknown。
- 计划授权：ops_schedule_fires既有schedule_id/slot/run_id/schedule_revision关联当前ops_schedules.authorized_by/resource_revision/enabled。
- 应用备份：应用/实例/项目、完整挂载和配置、uid/gid/mode/sha256、停机一致性、归档size/sha256；文件不进入任务JSON。
- 迁移：版本、镜像digest、state/telemetry卷、配置及归档摘要、外部存储标记；空目标才允许导入。
