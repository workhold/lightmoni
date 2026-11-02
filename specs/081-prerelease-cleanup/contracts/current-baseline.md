# 当前契约

- 仅支持本次首次发布基线创建的中心数据库；历史开发库需离线备份后使用空目录重新初始化。启动不得隐式搬运或清空数据。
- 所有 SQLite 最终字段在 CREATE TABLE 中声明；ClickHouse 系统表统一 logical_name=lightmoni，不创建 lightmoni_center/lightmoni_agent/lightmoni_sdk 的别名。
- 主机标签和独立任务是唯一任务分发模型；中央 connection_credentials 为凭据密文唯一来源。
- 应用使用 deployments，网站使用 cluster_ids 与 cluster_targets；系统应用使用 sys-openresty/sys-docker-registry 的固定身份。
- 独立执行器无 migration/migration-worker CLI，受管业务仅使用 /var/lib/lightmoni-managed。
- 普通 Agent、独立执行器、凭据签名、未知执行恢复与当前程序维护/回退契约保持有效。

部署唯一入口为根 compose.yaml；应用端口仅支持 host_ports 命名映射，parameters.port 拒绝。管理员 CLI 与中心共享同一存储基线验证，CLI 空库初始化后可直接启动中心。
