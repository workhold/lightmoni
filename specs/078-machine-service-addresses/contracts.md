# 契约

- GET `/api/v1/machines/:id/service-addresses`：管理员读取 `{revision,target_generation,private:{mode,address,effective,source,needs_confirmation},public:{...},candidates:[{address,scope,source,interface?,observed_at,requires_confirmation}],updated_by,updated_at}`。mode 为 auto/manual，source 区分 interface、manual、legacy、unavailable；候选 SSH/平台来源不是有效服务地址。
- PUT 同路径：`{revision,target_generation,private:{mode,address},public:{mode,address}}`，返回保存后同一表示。自动模式地址必须为空；手动模式为单个无端口字面 IP。未知字段或类型错误返回400；revision 冲突/SSH代际变化返回409，失败零写入。成员/非管理员403。
- 主机 `network.service_addresses` 使用相同投影；旧 `addresses/private_ips/public_ips/source_ip` 等仍表示原观测，保持兼容。
- `machineServiceAddresses` 返回形状不变。private_ips/public_ips 为有效选择的集合，人工模式只使用该项；address 继续内网优先，public_address 只使用公网。人工设置不当前时有效值为空并 needs_confirmation，不能悄悄退回另一来源。
- 当前 SSH 数字地址和当前已认证连接的公网来源仅作为可点击候选；不信任转发头、不把代理内网作为主机内网、不增加第三方外发或 SSH 域名解析。
- OpenResty 的只读 `status.gateway_dns[cluster_id]` 区分 external/domain_required/not_deployed/awaiting_entry/eligible/public_ip_required/partial_public_ip_required，并提供 missing_public_machine_ids。自动托管入口缺公网地址时，网站 CNAME 资格返回 machine_public_service_address_required；自行维护的外部入口仍由用户负责。空记录清理的厂商回读不能掩盖该缺失原因。
