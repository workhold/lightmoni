# Data Model — 2026-10-30最终跨集群模型

## cluster
spec:{machine_ids:稳定主机ID[],port_start,port_end,nodes:[{machine_id,address,public_address?,cpu?,memory_mb?}]}。一机一集群，采集标签分组独立。

## application（全局一套逻辑应用）
name可重复展示名；spec:{service_name,source:{type:store|custom,template_id?,template_version?},role:generic|openresty,deployment_mode:manual|managed,deployments:[{cluster_id,machine_ids?:手动选择,replicas:托管数量,cpu:每实例,memory_mb:每实例,stateful_acknowledged?}],ports:[{name,container_port,host_port:0自动或正整数固定,protocol,app_protocol?,host_ip?,service?:Compose组件}],mode:container|compose,image?,compose?,environment?,command?,entrypoint?,mounts,health:{type,port_name,path?,interval_seconds?}}。
service_name全局唯一且创建后不可改。一个应用每集群最多一项deployment；部署模式全局选择，实例数量/资源按集群。共享镜像、版本、命名端口与固定宿主端口；逐集群动作发布时分别冻结资源修订。无状态managed可故障换机，stateful默认手动，已明确知悉限制的managed有状态不自动跨机迁移。

## application_deployment / instance
持久部署表PK(application_id,cluster_id)，保存desired_revision/授权主体/enabled/观察状态。OpenResty角色按cluster唯一，而非全局应用唯一。实例显式cluster_id；活跃slot唯一(owner_id,cluster_id,slot)。端口整体预留，固定冲突跳过节点，不自动改号。映射、状态、退役attempt及版本保持可追溯。

## website（全局公共配置 + 各路径集群上游）
spec:{cluster_ids:网站应用范围,bindings:[{domains,https?,certificate_id?,dns_enabled?,dns_zone_id?,locations:[{...共享现有Nginx路径选项,cluster_targets:[{cluster_id,target:application|proxy,application_id?,port_name?,upstreams?}]}]}],nginx:全局超时/HTTPS/头部/缓存等,mode?,static_files?}。
cluster_ids由用户选择或选择全部现有集群。每个代理路径必须为作用范围中的每个集群提供唯一target；只有目标字段可变，各路径匹配、超时等仍全局。static/return动作不要求上游。绑定application必须存在对应cluster deployment及HTTP(S)端口；无健康端点保留绑定。OpenResty按每集群唯一部署自动解析，无website.openresty_application_id或任意cluster_overrides。

## DNS与网站状态
status.deployments[cluster_id]记录入口实例、实际网站修订和发布结果。DNS以网站为owner，对所有有效集群就绪OpenResty实例公网地址统一聚合；各集群不得独立覆盖同一网站记录。缺入口/缺就绪后端展示pending/503，不能跨集群发现。

## legacy normalization
既有单cluster application转deployments单项，资源ID/serviceName/数据目录/实例ID保留；旧实例cluster_id回填，旧网站bindings.locations目标转cluster_targets单项。不得自动重建运行容器或丢失数据。旧legacy node_pool/service/gateway_group保持只读历史。
