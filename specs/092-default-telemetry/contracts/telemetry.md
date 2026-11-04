# 遥测契约

## 权限与数据

- 容器共享表名和部署归属不变；签名执行器身份+当前策略提供授权，中心重新绑定application/cluster/machine/service/host/agent。
- 网站身份必须属于该OpenResty实例实际承载的集群；托管站点从保存的服务绑定和实际部署推导，不能仅依赖手动cluster_ids。
- SDK仍用数据Key直报，不经Agent；应用读取使用平台注入resource属性lightmoni.application_id，实例属性service.instance.id；覆盖配置遵循原SDK契约。
- 原始日志和指标的持久ACK、事件ID、游标不变；不删除拒绝批次以冒充恢复。

## 采集状态

签名心跳可带application_observation：state(waiting/ok/degraded)、attempted_at、last_success_at、error（固定安全码）、queue_batches/queue_bytes。缺少字段的旧安装显示未提供采集状态，不能推断成功。中心outbox的未完成记录/失败状态在监控manifest中体现。

## 读取API

- GET /api/v1/ops/resources/:id/monitoring：应用manifest及各主机采集状态。
- GET /api/v1/ops/resources/:id/telemetry：原容器load/logs/web结果不变；新增SDK指标/日志结果及表信息，最多1天范围，应用身份不可由浏览器覆写。
- GET /api/v1/ops/resources/:id/website-telemetry：保存的网站身份固定，返回站点manifest、按分钟QPS/耗时/状态聚合和最近访问日志；已有管理员safe鉴权。
- 各子查询错误独立展示；没有表/没有记录/查询失败分开表达。时间序列在用户时间范围内，不以最新历史值填充当前数据。

## 访问日志字段

保留lightmoni_access、website_id、status、request_time、upstream_addr；增加host、method、uri（不含querystring）。采集后保存website_id/http_status/request_duration及上述非秘密字段，查询以中心鉴权范围过滤。
