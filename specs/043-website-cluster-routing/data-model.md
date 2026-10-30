# Data Model

ApplicationDeployment新增 gateway_domain（标准FQDN，OpenResty专用，可为空用于旧数据）、gateway_dns_zone_id（可选，必须包含gateway_domain）。全局role=openresty唯一；每集群唯一索引仍保留。
Website新增 routing_mode=manual|managed（旧manual）、service_application_id/service_port_name（managed必需，非OpenResty HTTP(S) TCP端口）、dns_record_mode=cname|address（旧address，新UI默认cname）、cluster_policies=[{cluster_id,enabled:true,weight:1,default:true,lines:[{id,name}]}]。线路由DNS区域的厂商目录获得；id是厂商标识，name用于显示。实际发现的集群保存status.actual_cluster_ids和status.cluster_traffic，配置中的cluster_ids保留保存时快照。
ops_dns_owned增量加 line TEXT NOT NULL DEFAULT ''、weight INTEGER，标识包含规范化线路；原记录保留原主键并按精确身份查找，兼容既有归属。line/weight/ttl更新后必须回读；未知写入不重新认领。已获RecordId但待索引或待独立权重调用核对时保留verifying，全部回读匹配后才转applied。
独立网站流量策略存在资源最新修订；DNS站点内容来自成功应用回执的冻结修订。managed新增集群基于最近发布修订，不使用未发布草稿；删除集群撤下自己的记录并关闭对应网站部署。

域名级扩展：website.domain_routes=[{domain,cluster_ids?,cluster_policies?}]。domain必须属于bindings中的规范域名且唯一；省略cluster_ids表示跟随全部可用集群，显式非空数组表示固定选择，保存时必须是网站候选集群的子集。省略cluster_policies继承网站默认策略；显式策略按cluster_id覆盖默认策略，保存和DNS预检沿用原校验。域名范围冻结随网站发布，策略从最新授权修订读取。旧配置domain_routes缺省为空，行为不变。

每集群siteBundle只生成分配到该集群的domains，同绑定组的TLS、路径与网站配置复用；手动后端只要求覆盖该绑定组实际使用集群。DNS取期望发布范围与成功回执范围的交集，域名之间不互相回退。status.actual_cluster_ids为已发布域名实际集群的并集；status.domain_traffic按域名记录cluster_ids和eligible_cluster_ids，限制摘要字节数并标记截断。原部署候选集群仍可收到空站点包以清理此前域名，不能遗留未绑定域名。
