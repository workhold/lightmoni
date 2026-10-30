# Data Model

ApplicationDeployment新增 gateway_domain（标准FQDN，OpenResty专用，可为空用于旧数据）、gateway_dns_zone_id（可选，必须包含gateway_domain）。全局role=openresty唯一；每集群唯一索引仍保留。
Website新增 routing_mode=manual|managed（旧manual）、service_application_id/service_port_name（managed必需，非OpenResty HTTP(S) TCP端口）、dns_record_mode=cname|address（旧address，新UI默认cname）、cluster_policies=[{cluster_id,enabled:true,weight:1,default:true,lines:[{id,name}]}]。线路由DNS区域的厂商目录获得；id是厂商标识，name用于显示。实际发现的集群保存status.actual_cluster_ids和status.cluster_traffic，配置中的cluster_ids保留保存时快照。
ops_dns_owned增量加 line TEXT NOT NULL DEFAULT ''、weight INTEGER，标识包含规范化线路；原记录保留原主键并按精确身份查找，兼容既有归属。line/weight/ttl更新后必须回读；未知写入不重新认领。已获RecordId但待索引或待独立权重调用核对时保留verifying，全部回读匹配后才转applied。
独立网站流量策略存在资源最新修订；DNS站点内容来自成功应用回执的冻结修订。managed新增集群基于最近发布修订，不使用未发布草稿；删除集群撤下自己的记录并关闭对应网站部署。
