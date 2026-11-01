# 兼容契约

- POST /ops/catalog/:id/install增加可选host_ports: Record<port_name, integer 0..65535>与listen_ip: '0.0.0.0'|'127.0.0.1'。未知名称、非整数/范围外、重复非零同协议端口拒绝400；OpenResty不接受改写host端口。旧parameters.port仍有效，host_ports中显式值优先。
- application.spec.deployments[].host_ports可选；仅覆盖application.spec.ports已声明名称，未提供名称沿用共享ports默认。省略整个字段保持旧结构；各集群独立冻结/发布。
- POST /ops/private-registry/deployments增加可选host_ports；省略时继承该集群旧值，新部署默认0自动。GET /ops/private-registry.deployments[]返回host_ports，供编辑回读；endpoint保留原格式。
- 不新增任意命令、鉴权、主机公网监听、数据删除或AI授权。system registry仍经专用控制器写入；缓存配置和外部网站使用既有命名端点发现。
