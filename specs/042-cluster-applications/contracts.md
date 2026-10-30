# Contracts — 2026-10-30最终模型

## Resources
/api/v1/ops/resources CRUD继续公开credential,dns_zone,acme_account,certificate,certificate_target,cluster,application,website。写入保留revision；actions保留confirmed=true。应用和网站全局对象，可按cluster_id查询包含该集群部署/作用范围的资源。旧service/node_pool/gateway_group不再新建或部署。
GET /ops/overview:resources,agents,machines,runs,capabilities；machines稳定ID和cluster_id。

## Application
见data-model.md：spec.deployment_mode为manual|managed；spec.deployments数组逐集群设置cluster_id,machine_ids或replicas,cpu,memory_mb，移除新模型顶层cluster_id/machine_ids/cpu/memory_mb。service_name全局唯一且不可变。ports.host_port对两种模式均可固定，0自动。
Actions deploy/inspect/stop/remove/logs/endpoints/reconcile，input.cluster_id可指定一个部署；缺省对应用已配置集群分别执行，返回各集群结果且一处失败不能冒充全部成功。发布只改变目标集群desired_revision，其他集群已发布快照不变。GET resources/:id/endpoints?cluster_id=...&port_name=...返回service_name和带cluster_id的健康端点；网站强制指定当前集群。
GET /ops/catalog返回模板；POST /ops/catalog/:id/install body:{name?,service_name?,deployment_mode?,deployments:[{cluster_id,machine_ids?,replicas?,cpu?,memory_mb?}],parameters?,confirmed?}。confirmed=true保存后立即部署，false只保存。返回{resource,runs?,deployment_error?}；创建成功部署失败应返回resource和明确deployment_error，避免用户重试创建重复应用。
OpenResty支持managed，host80/443固定，每cluster最多一项OpenResty部署。现场端口冲突使候选失败并重新选择；无候选保持pending且保留固定端口配置。

## Website
全局cluster_ids,bindings,nginx/static_files。bindings中域名/证书/HTTPS/DNS和locations的路径/超时等公共选项统一；locations[].cluster_targets逐集群仅填写target:application|proxy,application_id+port_name或upstreams。服务端拒绝公共配置的任意集群覆盖。
每个application目标必须存在对应cluster deployment，保存和发布均检查，前端只显示可绑定应用。临时无健康实例允许保留绑定，返回503。删除被引用deployment/port拒绝。
Actions deploy/inspect/disable可按input.cluster_id指定发布；GET resources/:id/nginx?cluster_id=...查看该集群脱敏有效配置。网站发布状态按cluster和入口实例记录。DNS按网站聚合全部生效集群，随OpenResty托管调度变化刷新，只有现场验证通过节点贡献公网IP。

## Errors / Agent
明确区分application_not_deployed_in_cluster,application_port_not_found,application_deployment_in_use,machine_already_in_cluster,service_name_conflict,service_name_immutable,openresty_already_installed,host_port_already_reserved与revision冲突。普通任务不含秘密，私有载荷仍需Agent control凭据与有效lease。操作载荷携带cluster_id和冻结配置修订，陈旧回执不得覆盖其他集群状态。

## Demo
保留真实MySQL+自定义Web双端口+OpenResty+测试自签TLS。新增跨集群控制面/实例隔离与DNS聚合验收，实际Docker不伪称多物理机；条件允许增加第二独立Docker节点命名空间。仅域名解析和公有证书使用mock。
