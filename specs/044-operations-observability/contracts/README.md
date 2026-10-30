# Contracts

- `GET /ops/catalog`: 兼容返回 templates，附 categories；类别稳定 ID、中文与英文名称、数量。
- Agent 心跳请求增加可选 `docker_inventory`，最多 500 个容器及 observed_at/state/error/truncated；中心仅持久化白名单字段。回包增加 `application_targets`（本 Agent 实例 ID、application_id、cluster_id、service_name、role），旧 Agent 兼容忽略。
- `GET /ops/inventory?machine_id=&cluster_id=`: 管理员只读；applications 与逐主机 containers/observed_at/state，字段来自白名单快照；不执行部署操作。
- `GET /ops/resources/:id/monitoring`: 管理员只读自动目录，返回 application、deployments、hosts（内含 containers）、tables 与绑定网站；无写大盘副作用。
- `GET /ops/resources/:id/telemetry`: 集群、主机、部署实例、容器与最多24小时的时间范围；load/logs/web 各自保留 Query 状态和截断标记。网站只允许已保存的“网站+集群”绑定，按分钟返回 QPS 与平均耗时。
- `GET /ops/system-logs`: 管理员通过统一 Query 读取 `lightmoni_log`，按 kind/resource_id/machine_id/cluster_id 及时间过滤，最多200行。ClickHouse 失败返回查询错误，不能伪装为无记录。
- `GET /ops/runs/:id`: 管理员读取单条脱敏控制回执，供历史日志打开详情；不受 overview 最近100条限制，找不到返回404。
- 系统逻辑表 `lightmoni_application`：metrics 仅 gauge、logs 任意日志体；两个物理表各一，attributes 包含 application_id/cluster_id/deployment_id/container_id/container_name/service_name；event_time 保留来源时间。Agent ID从凭据认证核验。无权实例返回403；业务 Key写入返回403。
- 监控查询使用现有 `/query` 只读 AST/时间/行数上限，按上述 attributes 过滤；共享日志仍可进入现有日志浏览器。
- 日志游标按容器保存时间戳及同时间戳已发送行数，在持久队列事务中更新；队列失败不得推进。日志读出后分批入队，不以tail截去积压。
- 系统日志使用 `lightmoni` 内部链路，与应用日志两表区分。SQLite outbox 跟随原状态事务，既有记录按完整主键幂等补录；ClickHouse 成功后清除已投递正文。任务解释脱敏后导出，快照、脚本与交互终端输出不导出。
