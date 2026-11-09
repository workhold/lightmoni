# Research
通过speckit-plan三个研究代理只读审查遥测、部署、文件备份。

- Agent发送侧缺少调度器已读取的cpu_count/memory_total_mb，补既有契约，不另造字段。
- 大盘已有Grafana parity、日志已有2000行虚拟化，先复测，不据旧表重复改架构。
- 标签API已经正确；实际瓶颈是tag和index child串行manifest，采用有界并发和Promise去重。
- 文件已有真人cookie、账户租约、指纹、版本和审计，继续SFTP而非shell。
- 外部Compose项目/卷名与平台实例生成规则不同，沿用操作资源adopt而非建立第二平台项目。
- 现单目录备份64/256MiB、root-only、缺属主和多卷，不能冒充完整应用备份；采用完整流式制品。
- 定时schedule:actor不能通过active_human_admin_required，结构化校验来源，不能只去前缀。
- 迁移需state/master.key、telemetry、配置、镜像digest；不能仅复制SQLite或复制原主机执行身份。

夹具不等于生产，未执行环境验证如实记录。
